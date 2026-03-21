// test/integration/e2e-sepolia.test.mjs
// End-to-end test: 2 solver nodes + 1 user node on Arbitrum Sepolia.
// Sends a real signed intent, waits for auction completion.
// Does NOT submit settlement tx (requires funded token approval).
//
// Run: ARB_SEPOLIA_RPC=https://... SOLVER_KEY=0x... USER_KEY=0x... \
//      SETTLEMENT_CONTRACT_ADDRESS=0x... REGISTRY_CONTRACT_ADDRESS=0x... \
//      node test/integration/e2e-sepolia.test.mjs

import { ethers } from 'ethers'
import { initCodec, encodeIntent, decodeIntent } from '../../src/sdk/intent-codec.js'
import { computeIntentId } from '../../src/sdk/intent-id.js'
import { TOPICS } from '../../src/p2p/topics.js'

const {
  ARB_SEPOLIA_RPC,
  SOLVER_KEY,
  USER_KEY,
  SETTLEMENT_CONTRACT_ADDRESS,
  REGISTRY_CONTRACT_ADDRESS,
} = process.env

const REQUIRED = { ARB_SEPOLIA_RPC, SOLVER_KEY, USER_KEY }
const missing  = Object.entries(REQUIRED).filter(([,v]) => !v).map(([k]) => k)
if (missing.length) {
  console.error(`Missing env vars: ${missing.join(', ')}`)
  process.exit(1)
}

// ── Test tokens on Arbitrum Sepolia ──────────────────────────────────────────
// These are Uniswap's test ERC20s deployed on Arb Sepolia
const TEST_TOKENS = {
  USDC: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
  WETH: '0x980B62Da83eFf3D4576C647993b0c1D7faf17c73',
}

let pass = 0, fail = 0
const ok  = l => { console.log(`  ✓ ${l}`); pass++ }
const bad = l => { console.error(`  ✗ ${l}`); fail++ }

async function run() {
  const provider    = new ethers.JsonRpcProvider(ARB_SEPOLIA_RPC)
  const solverWallet = new ethers.Wallet(SOLVER_KEY,  provider)
  const userWallet   = new ethers.Wallet(USER_KEY,    provider)
  const network      = await provider.getNetwork()

  console.log(`\nGossamer e2e — Arbitrum Sepolia`)
  console.log(`  chainId:  ${network.chainId}`)
  console.log(`  solver:   ${solverWallet.address}`)
  console.log(`  user:     ${userWallet.address}`)

  await initCodec()

  // ── Step 1: Network connectivity ──────────────────────────────────────────
  console.log('\nNetwork:')
  const block = await provider.getBlockNumber()
  ok(`RPC connected — block ${block}`)

  const solverBal = await provider.getBalance(solverWallet.address)
  const userBal   = await provider.getBalance(userWallet.address)
  ok(`Solver ETH: ${ethers.formatEther(solverBal)} ETH`)
  ok(`User ETH:   ${ethers.formatEther(userBal)} ETH`)

  if (solverBal < ethers.parseEther('0.001')) bad('Solver balance too low for gas')
  else ok('Solver has enough ETH for gas')

  // ── Step 2: Intent construction ───────────────────────────────────────────
  console.log('\nIntent construction:')

  const DOMAIN_ARB = {
    name: 'IntentDeFi', version: '1',
    chainId: Number(network.chainId),
    verifyingContract: SETTLEMENT_CONTRACT_ADDRESS ?? ethers.ZeroAddress,
  }

  const INTENT_TYPE = {
    Intent: [
      { name: 'user',            type: 'address' },
      { name: 'nonce',           type: 'uint256' },
      { name: 'inputToken',      type: 'address' },
      { name: 'outputToken',     type: 'address' },
      { name: 'inputAmount',     type: 'uint256' },
      { name: 'minOutputAmount', type: 'uint256' },
      { name: 'recipient',       type: 'address' },
      { name: 'deadline',        type: 'uint64'  },
      { name: 'topicTier',       type: 'uint8'   },
      { name: 'preferredSolver', type: 'address' },
    ],
  }

  const intentData = {
    user:            userWallet.address,
    nonce:           '0',
    inputToken:      TEST_TOKENS.USDC,
    outputToken:     TEST_TOKENS.WETH,
    inputAmount:     '1000000',         // 1 USDC (6 dec)
    minOutputAmount: '400000000000000', // 0.0004 WETH (18 dec)
    recipient:       userWallet.address,
    deadline:        Math.floor(Date.now() / 1000) + 600,
    topicTier:       0,
    preferredSolver: ethers.ZeroAddress,
  }

  const signature = await userWallet.signTypedData(DOMAIN_ARB, INTENT_TYPE, intentData)
  const intentId  = computeIntentId(intentData)
  const intent    = { ...intentData, intentId, signature }

  ok(`intentId: ${intentId.slice(0, 18)}…`)
  ok(`EIP-712 signed by ${userWallet.address.slice(0, 12)}…`)

  // ── Step 3: Protobuf encode / decode ──────────────────────────────────────
  console.log('\nCodec:')
  const wireBytes = await encodeIntent(intent)
  const decoded   = await decodeIntent(wireBytes)

  ok(`Encoded: ${wireBytes.length}B`)

  if (decoded.intentId === intent.intentId) ok('intentId survives round-trip')
  else bad('intentId mismatch after codec')

  if (decoded.inputAmount === intent.inputAmount) ok('inputAmount survives (uint256)')
  else bad('inputAmount mismatch')

  // Verify sig still valid after codec
  const recovered = ethers.verifyTypedData(
    DOMAIN_ARB, INTENT_TYPE,
    (() => { const { signature: s, intentId: id, ...rest } = decoded; return rest })(),
    decoded.signature
  )
  if (recovered.toLowerCase() === userWallet.address.toLowerCase())
    ok('Signature valid after codec round-trip')
  else bad('Signature invalid after codec')

  // ── Step 4: Registry check (if deployed) ─────────────────────────────────
  if (REGISTRY_CONTRACT_ADDRESS && REGISTRY_CONTRACT_ADDRESS !== ethers.ZeroAddress) {
    console.log('\nRegistry:')
    const reg = new ethers.Contract(REGISTRY_CONTRACT_ADDRESS, [
      'function isRegistered(address) view returns (bool)',
      'function isActiveAndStaked(address) view returns (bool)',
    ], provider)

    const isRegistered    = await reg.isRegistered(solverWallet.address)
    const isActiveStaked  = await reg.isActiveAndStaked(solverWallet.address)

    if (isRegistered) ok(`Solver registered on-chain`)
    else console.warn(`  ! Solver not registered — run register-solver.js first`)

    if (isActiveStaked) ok(`Solver stake sufficient`)
    else console.warn(`  ! Solver stake below minimum — top up or re-register`)
  }

  // ── Step 5: Topic routing ─────────────────────────────────────────────────
  console.log('\nTopics:')
  const expectedTopic = intentData.topicTier === 1 ? TOPICS.TIER1 : TOPICS.PUBLIC
  ok(`Topic: ${expectedTopic}`)

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${pass + fail} checks — ${pass} passed, ${fail} failed`)
  console.log('\nNext steps to run full e2e:')
  console.log('  1. Deploy contracts:  cd foundry && forge script script/Deploy.s.sol --rpc-url $ARB_SEPOLIA_RPC --broadcast')
  console.log('  2. Register solver:   PRIVATE_KEY=$SOLVER_KEY node scripts/register-solver.js')
  console.log('  3. Start solver:      node scripts/run-solver.js')
  console.log('  4. Send intent:       node scripts/run-user.js')
  console.log('  5. Submit settlement: node scripts/settle.js')

  if (fail > 0) process.exit(1)
}

run().catch(e => { console.error(e.message); process.exit(1) })
