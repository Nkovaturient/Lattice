#!/usr/bin/env node
/**
 * settle-debug.js — Layered on-chain preflight for IntentSettlement.sol
 *
 * Walks every precondition that settle() checks, in the exact order the
 * contract evaluates them, so you see precisely which require() fails —
 * before you spend gas or lose the revert reason through a noisy gateway.
 *
 * Usage:
 *   node scripts/settle-debug.js
 *
 * Env (same .env as run-solver.js):
 *   PRIVATE_KEY, ARB_SEPOLIA_RPC, SETTLEMENT_CONTRACT_ADDRESS,
 *   INTENT_JSON (path to `{ "intent": {…}, "bid": {…} }` — e.g. DUMP_SETTLEMENT_JSON from run-solver.js)
 *
 * The script logs each check as ✓ PASS or ✗ FAIL with an actionable fix,
 * then attempts a staticCall and decodes the raw revert bytes directly
 * (bypassing Ethers' lossy error wrapping) so you get the selector even
 * when the gateway drops Error(string).
 */

import 'dotenv/config'
import { ethers } from 'ethers'
import { readFileSync, existsSync } from 'fs'
import { createRatedJsonRpcProvider } from '../node/rpc-provider.js'
import { IntentSettlementABI } from '../ABI/IntentSettlementABI.js'
import { SolverRegistryABI }   from '../ABI/SolverRegistryABI.js'
import { MockERC20ABI }        from '../ABI/MockERC20ABI.js'

// ── Colour helpers (no external dep) ─────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  grey:   '\x1b[90m',
}
const ok   = (msg) => console.log(`  ${C.green}✓${C.reset} ${msg}`)
const fail = (msg, fix) => {
  console.log(`  ${C.red}✗${C.reset} ${C.bold}${msg}${C.reset}`)
  if (fix) console.log(`    ${C.yellow}→${C.reset} ${fix}`)
}
const info = (msg) => console.log(`  ${C.grey}·${C.reset} ${msg}`)
const section = (title) =>
  console.log(
    `\n${C.cyan}${C.bold}── ${title} ${'─'.repeat(Math.max(0, 50 - title.length))}${C.reset}`
  )

// ── Minimal ABI fragments needed here ────────────────────────────────────────
const SETTLEMENT_FRAGMENTS = [
  'function settled(bytes32) view returns (bool)',
  'function registry() view returns (address)',
  'function settle(tuple(address,uint256,address,address,uint256,uint256,address,uint256,uint256,address), bytes, tuple(bytes32,address,uint256,bytes,uint256), bytes)',
]

const REGISTRY_FRAGMENTS = [
  'function isRegistered(address) view returns (bool)',
  'function isActiveAndStaked(address) view returns (bool)',
  'function solverTier(address) view returns (uint8)',
  'function nonces(address) view returns (uint256)',
  'function stake(address) view returns (uint256)',
  'function TIER0_MIN_STAKE() view returns (uint256)',
  'function TIER1_MIN_STAKE() view returns (uint256)',
  'function solvers(address) view returns (bool,uint8,uint256,uint256,uint256,string)',
]

const ERC20_FRAGMENTS = [
  'function allowance(address,address) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]

// ── Raw low-level eth_call (bypasses Ethers error wrapping) ──────────────────
/**
 * Sends a raw eth_call and returns the raw hex response — even if it's a
 * revert. Ethers v6 throws on reverts and sometimes loses the payload;
 * this preserves it so we can decode the selector manually.
 */
async function rawEthCall(provider, to, data) {
  const rpcRequest = {
    method:  'eth_call',
    params:  [{ to, data }, 'latest'],
    id:      1,
    jsonrpc: '2.0',
  }
  // Access the underlying fetch — works with ethers JsonRpcProvider
  const response = await provider.send('eth_call', [{ to, data }, 'latest'])
    .catch(err => {
      // When eth_call reverts, Ethers throws — extract the raw data
      const raw = err?.data ?? err?.error?.data ?? err?.info?.error?.data
      if (raw) return raw
      throw err
    })
  return response
}

// ── Revert decoder ────────────────────────────────────────────────────────────
const KNOWN_SELECTORS = {
  '0x08c379a0': (data) => {
    try {
      const [msg] = ethers.AbiCoder.defaultAbiCoder().decode(
        ['string'], ethers.dataSlice(data, 4)
      )
      return `Error("${msg}")`
    } catch { return 'Error(string) — decode failed' }
  },
  '0x4e487b71': (data) => {
    try {
      const [code] = ethers.AbiCoder.defaultAbiCoder().decode(
        ['uint256'], ethers.dataSlice(data, 4)
      )
      return `Panic(${code}) — ${panicCode(Number(code))}`
    } catch { return 'Panic(uint256) — decode failed' }
  },
}

function panicCode(code) {
  const map = {
    0x01: 'assert failed',         0x11: 'arithmetic overflow',
    0x12: 'divide by zero',        0x21: 'invalid enum value',
    0x22: 'corrupt storage array', 0x31: 'pop on empty array',
    0x32: 'index out of bounds',   0x41: 'too much memory allocated',
    0x51: 'zero function pointer',
  }
  return map[code] ?? `unknown panic code 0x${code.toString(16)}`
}

function decodeRevert(hex) {
  if (!hex || hex === '0x' || hex.length < 10) return null
  const sel = hex.slice(0, 10)
  const handler = KNOWN_SELECTORS[sel]
  if (handler) return handler(hex)
  return `custom error selector ${sel} (add to KNOWN_SELECTORS or check IntentSettlement ABI)`
}

// ── Intent / bid loading ──────────────────────────────────────────────────────
function loadIntentBid() {
  const envPath = process.env.INTENT_JSON
  if (envPath && existsSync(envPath)) {
    console.log(`${C.grey}Loading intent+bid from ${envPath}${C.reset}`)
    return JSON.parse(readFileSync(envPath, 'utf8'))
  }

  // Fallback — build a minimal fixture from env so you can test without
  // running the full mesh. Fill these in or set INTENT_JSON.
  console.log(`${C.yellow}No INTENT_JSON set — using env fixture (set INPUT_TOKEN etc.)${C.reset}`)
  const {
    PRIVATE_KEY,
    INPUT_TOKEN    = '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
    OUTPUT_TOKEN   = '0x980B62Da83eFf3D4576C647993b0c1D7faf17c73',
    INPUT_AMOUNT   = '1000000',
    MIN_OUTPUT     = '100000000000000',
  } = process.env

  const wallet = new ethers.Wallet(PRIVATE_KEY)
  return {
    intent: {
      user:            wallet.address,
      nonce:           '0',
      inputToken:      INPUT_TOKEN,
      outputToken:     OUTPUT_TOKEN,
      inputAmount:     INPUT_AMOUNT,
      minOutputAmount: MIN_OUTPUT,
      recipient:       wallet.address,
      deadline:        Math.floor(Date.now() / 1000) + 600,
      topicTier:       0,
      preferredSolver: ethers.ZeroAddress,
      signature:       process.env.INTENT_SIG ?? '0x',
    },
    bid: {
      intentId:     process.env.INTENT_ID ?? '0x' + '00'.repeat(32),
      solver:       wallet.address,
      outputAmount: process.env.BID_OUTPUT ?? '325013108561778',
      route:        process.env.BID_ROUTE  ?? '0x',
      deadline:     Math.floor(Date.now() / 1000) + 600,
      signature:    process.env.BID_SIG    ?? '0x',
    },
  }
}

// ── Main diagnostic ───────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${C.bold}${C.cyan}Lattice — settlement preflight diagnostic${C.reset}`)
  console.log(`${'═'.repeat(55)}`)

  const {
    PRIVATE_KEY,
    ARB_SEPOLIA_RPC,
    SETTLEMENT_CONTRACT_ADDRESS, INTENT_SETTLEMENT_ADDRESS,
    REGISTRY_CONTRACT_ADDRESS,   SOLVER_REGISTRY_ADDRESS,
    ARB_SEPOLIA_CHAIN_ID = '421614',
  } = process.env

  if (!PRIVATE_KEY || !ARB_SEPOLIA_RPC) {
    fail('PRIVATE_KEY and ARB_SEPOLIA_RPC are required')
    process.exit(1)
  }

  const settlementAddress = SETTLEMENT_CONTRACT_ADDRESS?.trim()
    || INTENT_SETTLEMENT_ADDRESS?.trim()
  const registryAddress   = REGISTRY_CONTRACT_ADDRESS?.trim()
    || SOLVER_REGISTRY_ADDRESS?.trim()

  if (!settlementAddress) {
    fail('SETTLEMENT_CONTRACT_ADDRESS unset', 'Set it to your deployed IntentSettlement address')
    process.exit(1)
  }

  const chainId  = Number(ARB_SEPOLIA_CHAIN_ID)
  const provider = createRatedJsonRpcProvider(ARB_SEPOLIA_RPC, chainId)
  const wallet   = new ethers.Wallet(PRIVATE_KEY, provider)

  const settlement = new ethers.Contract(settlementAddress, IntentSettlementABI ?? SETTLEMENT_FRAGMENTS, provider)

  const { intent, bid } = loadIntentBid()
  const solverAddr = ethers.getAddress(bid.solver ?? wallet.address)

  // ── 0. Network sanity ──────────────────────────────────────────────────────
  section('0 · Network sanity')
  const network = await provider.getNetwork()
  if (Number(network.chainId) === chainId) {
    ok(`RPC is chain ${network.chainId} (${network.name})`)
  } else {
    fail(`RPC returned chainId ${network.chainId}, expected ${chainId}`,
         'Check ARB_SEPOLIA_RPC points to Arbitrum Sepolia')
  }

  const bal = await provider.getBalance(wallet.address)
  if (bal > 0n) ok(`Solver wallet balance: ${ethers.formatEther(bal)} ETH`)
  else fail('Solver wallet has 0 ETH', 'Fund 0x…1Bf9 from a Sepolia faucet')

  // Check settlement contract exists (bytecode > 0)
  const code = await provider.getCode(settlementAddress)
  if (code.length > 2) {
    ok(`IntentSettlement code present at ${settlementAddress.slice(0, 14)}…`)
  } else {
    fail(`No contract at ${settlementAddress}`,
         'Check SETTLEMENT_CONTRACT_ADDRESS — contract may not be deployed')
    process.exit(1) // nothing else will work
  }

  // ── 1. Solver registry + stake (= isActiveAndStaked) ────────────────────────
  section('1 · Solver isActiveAndStaked (Solver not registered revert)')
  let registry = null
  try {
    const regAddrRaw = registryAddress?.trim?.()
      ? registryAddress.trim()
      : await settlement.registry()
    const regAddr = ethers.getAddress(regAddrRaw)
    registry = new ethers.Contract(regAddr, SolverRegistryABI ?? REGISTRY_FRAGMENTS, provider)
    ok(`SolverRegistry at ${regAddr.slice(0, 14)}… (${registryAddress?.trim() ? 'env' : 'settlement.registry()'})`)
  } catch (e) {
    fail(`Cannot resolve SolverRegistry (${e.shortMessage ?? e.message})`,
         'Set REGISTRY_CONTRACT_ADDRESS or verify settlement.registry() resolves.')
    process.exit(1)
  }

  {
    const isReg   = await registry.isRegistered(solverAddr)
    const active  = await registry.isActiveAndStaked(solverAddr)
    const tier    = isReg ? Number(await registry.solverTier(solverAddr)) : -1
    const stake   = isReg ? await registry.stake(solverAddr) : 0n
    const t0      = await registry.TIER0_MIN_STAKE()
    const t1      = await registry.TIER1_MIN_STAKE()
    info(`tier min stakes: TIER0=${ethers.formatEther(t0)} ETH, TIER1=${ethers.formatEther(t1)} ETH`)

    if (!isReg) {
      fail(`Solver ${solverAddr.slice(0, 14)}… is NOT registered`,
           'Run: node scripts/register-solver.js (with PEER_ID set to your solver PeerID)')
    } else ok(`Solver registered — tier ${tier}, stake ${ethers.formatEther(stake)} ETH`)

    if (isReg && !active)
      fail('isActiveAndStaked is false (settle() line 110 reverts “Solver not registered”)',
           'Deposit enough stake for your tier — `isRegistered` alone is insufficient.')
    else if (isReg && active)
      ok('isActiveAndStaked — passes on-chain gate used by IntentSettlement.settle')

    if (isReg && Number(intent.topicTier) === 1 && tier < 1) {
      fail(`Intent topicTier=1 but solver is tier ${tier}`,
           'Either register as tier-1 (needs 10+ fills) or sign intents with topicTier=0')
    } else if (isReg) {
      ok(`topicTier=${intent.topicTier} compatible with solver tier ${tier}`)
    }
  }

  // ── 2. Nonce (on SolverRegistry, not settlement) ───────────────────────────
  section('2 · Nonce (registry.nonces — “Nonce mismatch”)')
  try {
    const onChainNonce = await registry.nonces(intent.user)
    const intentNonce  = BigInt(intent.nonce)
    info(`registry.nonces(${intent.user.slice(0, 10)}…) = ${onChainNonce}`)
    info(`intent.nonce (signed) = ${intentNonce}`)
    if (onChainNonce === intentNonce) {
      ok('Nonce matches — aligns with SolverRegistry.incrementNonce caller')
    } else {
      fail(`Nonce mismatch: registry.nonces=${onChainNonce}, intent signed with ${intentNonce}`,
           'Re-sign intent after `await registry.nonces(user)` (nonce is on SolverRegistry.)')
    }
  } catch (e) {
    fail(`Could not read registry.nonces(): ${e.message}`)
  }

  // ── 3. Deadline ────────────────────────────────────────────────────────────
  section('3 · Deadline')
  const now = Math.floor(Date.now() / 1000)
  const ttl = Number(intent.deadline) - now
  if (ttl > 0) {
    ok(`Deadline valid — ${ttl}s remaining (${new Date(intent.deadline * 1000).toISOString()})`)
  } else {
    fail(`Intent expired ${-ttl}s ago (deadline ${intent.deadline}, now ${now})`,
         'Build a fresh intent with run-user.js — deadline is set 600s from build time')
  }
  const bd = bid.deadline ?? intent.deadline
  const bdTtl = Number(bd) - now
  if (bdTtl > 0 && Number(bd) <= Number(intent.deadline))
    ok(`Bid deadline OK — ${bdTtl}s remaining; bid ≤ intent deadline`)
  else if (Number(bd) > Number(intent.deadline))
    fail(`Bid deadline (${bd}) exceeds intent (${intent.deadline})`,
         `settle reverts “Bid extends past intent”`)
  else
    fail(`Bid expired ${-bdTtl}s ago`,
         `Run solver again so bid.deadline is refreshed`)

  // ── 4. ERC-20 allowance and balance ───────────────────────────────────────
  section('4 · ERC-20 allowance + balance (transferFrom)')
  try {
    const token    = new ethers.Contract(intent.inputToken, MockERC20ABI ?? ERC20_FRAGMENTS, provider)
    const symbol   = await token.symbol().catch(() => '?')
    const decimals = await token.decimals().catch(() => 18n)
    const balance  = await token.balanceOf(intent.user)
    const allowed  = await token.allowance(intent.user, settlementAddress)
    const need     = BigInt(intent.inputAmount)
    const fmt      = (v) => ethers.formatUnits(v, decimals)

    info(`${symbol} ${intent.inputToken.slice(0, 14)}… decimals=${decimals}`)
    info(`balance  of user: ${fmt(balance)} ${symbol}`)
    info(`allowance to settlement: ${fmt(allowed)} ${symbol}`)
    info(`intent.inputAmount: ${fmt(need)} ${symbol}`)

    if (balance >= need) ok(`User balance sufficient (${fmt(balance)} ≥ ${fmt(need)})`)
    else fail(`Insufficient balance: user has ${fmt(balance)}, needs ${fmt(need)}`,
              `Cast: cast send ${intent.inputToken} "mint(address,uint256)" ${intent.user} ${need * 2n} ...`)

    if (allowed >= need) ok(`Allowance sufficient (${fmt(allowed)} ≥ ${fmt(need)})`)
    else fail(`Insufficient allowance: ${fmt(allowed)} < ${fmt(need)}`,
              `Cast: cast send ${intent.inputToken} "approve(address,uint256)" ` +
              `${settlementAddress} ${need * 2n} --private-key $PRIVATE_KEY --rpc-url $ARB_SEPOLIA_RPC`)
  } catch (e) {
    fail(`ERC-20 check failed: ${e.message}`)
  }

  // ── 5. Intent signature ────────────────────────────────────────────────────
  section('5 · EIP-712 intent signature (off-chain pre-check)')
  try {
    // Rebuild the digest locally and recover the signer
    const { DOMAIN, INTENT_TYPE } = await import('../sdk/domain.js')
    const typedHash = ethers.TypedDataEncoder.hash(DOMAIN, INTENT_TYPE, {
      user:            intent.user,
      nonce:           BigInt(intent.nonce),
      inputToken:      intent.inputToken,
      outputToken:     intent.outputToken,
      inputAmount:     BigInt(intent.inputAmount),
      minOutputAmount: BigInt(intent.minOutputAmount),
      recipient:       intent.recipient,
      deadline:        BigInt(intent.deadline),
      topicTier:       BigInt(intent.topicTier),
      preferredSolver: intent.preferredSolver,
    })
    const recovered = ethers.recoverAddress(typedHash, intent.signature)
    if (recovered.toLowerCase() === intent.user.toLowerCase()) {
      ok(`Intent signature valid — recovered ${recovered.slice(0, 14)}…`)
    } else {
      fail(`Intent signature mismatch: signed by ${recovered.slice(0, 14)}…, intent.user is ${intent.user.slice(0, 14)}…`,
           'Re-sign with the user wallet that owns the tokens')
    }
  } catch (e) {
    fail(`Cannot verify intent signature: ${e.message}`)
  }

  // ── 6. Bid min-output floor ────────────────────────────────────────────────
  section('6 · Bid output vs minOutputAmount')
  const bidOut = BigInt(bid.outputAmount)
  const minOut = BigInt(intent.minOutputAmount)
  if (bidOut >= minOut) {
    ok(`bid.outputAmount ${bidOut} ≥ intent.minOutputAmount ${minOut}`)
  } else {
    fail(`bid.outputAmount ${bidOut} < minOutputAmount ${minOut}`,
         'Slippage check fails: loosen minOutputAmount or improve the DEX route')
  }

  // ── 7. Raw staticCall with revert decode ──────────────────────────────────
  section('7 · Raw eth_call (bypasses Ethers error wrapping)')
  console.log(`  ${C.grey}This is the ground truth — Ethers sometimes loses revert data, raw eth_call does not.${C.reset}`)

  try {
    const iface = new ethers.Interface(IntentSettlementABI ?? SETTLEMENT_FRAGMENTS)

    const intentTuple = [
      ethers.getAddress(intent.user),
      BigInt(intent.nonce),
      ethers.getAddress(intent.inputToken),
      ethers.getAddress(intent.outputToken),
      BigInt(intent.inputAmount),
      BigInt(intent.minOutputAmount),
      ethers.getAddress(intent.recipient),
      Number(intent.deadline),
      Number(intent.topicTier),
      ethers.getAddress(intent.preferredSolver ?? ethers.ZeroAddress),
    ]

    const bidTuple = [
      bid.intentId.startsWith('0x') ? bid.intentId : ethers.hexlify(bid.intentId),
      ethers.getAddress(bid.solver),
      BigInt(bid.outputAmount),
      typeof bid.route === 'string' && bid.route.startsWith('0x')
        ? bid.route
        : ethers.hexlify(bid.route ?? bid.encodedRoute ?? new Uint8Array(0)),
      Number(bid.deadline ?? intent.deadline),
    ]

    const calldata = iface.encodeFunctionData('settle', [
      intentTuple,
      intent.signature,
      bidTuple,
      bid.signature,
    ])

    // Use provider.send to get the raw JSON-RPC response
    let rawResult
    try {
      rawResult = await provider.send('eth_call', [
        { to: settlementAddress, data: calldata, from: wallet.address },
        'latest',
      ])
      ok(`staticCall returned success! No revert — the tx should land.`)
      info(`Return data: ${rawResult.slice(0, 66)}…`)
    } catch (rpcErr) {
      // Extract raw revert data from the RPC error
      const revertData =
        rpcErr?.error?.data ??
        rpcErr?.data ??
        rpcErr?.info?.error?.data ??
        rpcErr?.error?.error?.data

      if (revertData && typeof revertData === 'string') {
        const decoded = decodeRevert(revertData)
        fail(`settle() reverts — raw selector: ${revertData.slice(0, 10)}`)
        if (decoded) console.log(`    ${C.yellow}Decoded:${C.reset} ${decoded}`)
        else         console.log(`    ${C.grey}Add selector to KNOWN_SELECTORS or check ABI${C.reset}`)
      } else {
        fail(`settle() reverts — no revert data from RPC (gateway dropped it)`)
        console.log(`    ${C.yellow}→${C.reset} Try a keyed RPC (Alchemy / Infura / QuickNode) — public Arb gateway drops nested reverts`)
        console.log(`    ${C.yellow}→${C.reset} Run: cast call ${settlementAddress} "settle(...)" <args> --rpc-url $ARB_SEPOLIA_RPC --trace`)
      }
    }
  } catch (e) {
    fail(`Could not encode settle() calldata: ${e.message}`)
    info('Check that IntentSettlementABI matches the deployed contract')
  }

  // ── 8. One-shot cast diagnostic (requires INTENT_JSON — same tuples as solver) ─
  section('8 · Foundry: one-liner with encoded calldata (keyed RPC recommended)')
  console.log(`  ${C.grey}Print calldata:${C.reset} INTENT_JSON=<path> node scripts/emit-settle-calldata.mjs`)
  console.log()
  console.log(`  ${C.bold}One-liner (paste after exporting env — simulates settle as ${wallet.address.slice(0, 10)}…):${C.reset}`)
  console.log()
  console.log(
    `${C.grey}  DATA=$(INTENT_JSON=$INTENT_JSON node scripts/emit-settle-calldata.mjs) && cast call ${settlementAddress} "$DATA" --rpc-url "$ARB_SEPOLIA_RPC" --from ${wallet.address} --trace${C.reset}`
  )
  console.log()
  console.log(`  ${C.grey}Solidity revert strings propagate when the RPC does not strip Error(string); for Uniswap “empty” bytes, crank --verbosity or use Tenderly/trace.${C.reset}`)

  // ── Summary ────────────────────────────────────────────────────────────────
  section('Summary')
  console.log()
  console.log(`  Settlement contract: ${settlementAddress}`)
  console.log(`  Registry contract:   ${registry.target}`)
  console.log(`  Solver wallet:       ${wallet.address}`)
  console.log(`  Intent user:         ${intent.user}`)
  console.log()
  console.log(`  ${C.grey}Fix every ✗ above (order matters — check 1 first), then retry run-solver.js.${C.reset}`)
  console.log(`  ${C.grey}The P2P layer (GossipSub, auction, bid selection) is already proven healthy.${C.reset}`)
  console.log()
}

main().catch(e => {
  console.error(`\n${C.red}Fatal:${C.reset}`, e.message)
  process.exit(1)
})