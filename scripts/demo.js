#!/usr/bin/env node
// Gossamer terminal demo — Track 3.3 compute engine in isolation
// Simulates a full intent → pathfinding → bid pipeline without live RPC
// (uses mock pool state so you can run with no Infura key needed)
//
// Run: node scripts/demo.js

import { ethers } from 'ethers'
import { initCodec, encodeIntent, decodeIntent, encodeBid, decodeBid } from '../src/sdk/intent-codec.js'
import { computeIntentId } from '../src/sdk/intent-id.js'
import { DOMAIN, INTENT_TYPE } from '../src/sdk/domain.js'
import { buildBid, verifyBid } from '../src/sdk/bid-builder.js'
import { encodeSingleHop, encodeTwoHop, decodePath, FEE_TIERS, selectFeeTier } from '../src/sdk/route-encoder.js'
import { estimateOutput, UNISWAP_V3 } from '../src/node/compute-engine.js'

// ── Mock pool state (replaces live RPC for demo) ──────────────────────────────
// USDC(token0, 6dec) / WETH(token1, 18dec) at ~2500 USDC per WETH
// sqrtPriceX96 = sqrt(4e8) * 2^96 = 20000 * 2^96
const Q96 = 2n ** 96n
const MOCK_POOLS = {
  'usdc-weth': {
    sqrtPriceX96: 20000n * Q96,
    tick:         200000,
    liquidity:    BigInt('50000000000000000000'),
    token0:       '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
    token1:       '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH
    fee:          3000,
  },
  'weth-dai': {
    // WETH(token0,18dec) / DAI(token1,18dec) at ~2500 DAI per WETH
    // sqrtPriceX96 = sqrt(2500) * 2^96 = 50 * 2^96
    sqrtPriceX96: 50n * Q96,
    tick:         190000,
    liquidity:    BigInt('30000000000000000000'),
    token0:       '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH
    token1:       '0x6b175474e89094c44da98b954eedeac495271d0f', // DAI
    fee:          3000,
  },
}

// Mock pool resolver: returns pool address string or null
function mockResolvePool(tokenA, tokenB, fee) {
  const a = tokenA.toLowerCase()
  const b = tokenB.toLowerCase()
  const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
  const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
  const DAI  = '0x6b175474e89094c44da98b954eedeac495271d0f'

  if ((a === USDC && b === WETH || a === WETH && b === USDC) && fee === 3000)
    return 'usdc-weth'
  if ((a === WETH && b === DAI  || a === DAI  && b === WETH) && fee === 3000)
    return 'weth-dai'
  return null
}

function mockGetPool(poolAddr) { return MOCK_POOLS[poolAddr] ?? null }

// ── Inline demo compute (mirrors createComputeEngine but uses mock state) ─────
async function demoComputeSolution(solverSigner, intent) {
  const { inputToken, outputToken, inputAmount, minOutputAmount } = intent
  const amountIn = BigInt(inputAmount)
  const minOut   = BigInt(minOutputAmount)

  let bestOutput = 0n, bestRoute = null

  // Try direct pools for each fee tier
  for (const fee of Object.values(FEE_TIERS)) {
    const addr  = mockResolvePool(inputToken, outputToken, fee)
    if (!addr) continue
    const state = mockGetPool(addr)
    if (!state) continue
    const est = estimateOutput(state, inputToken, amountIn)
    if (est > bestOutput) { bestOutput = est; bestRoute = encodeSingleHop(inputToken, fee, outputToken) }
  }

  // Try 2-hop via WETH — iterate all fee tier combinations
  const WETH = UNISWAP_V3.WETH.toLowerCase()
  if (bestOutput < minOut &&
      inputToken.toLowerCase()  !== WETH &&
      outputToken.toLowerCase() !== WETH) {
    for (const fee01 of Object.values(FEE_TIERS)) {
      for (const fee12 of Object.values(FEE_TIERS)) {
        const p01 = mockResolvePool(inputToken, WETH, fee01)
        const p12 = mockResolvePool(WETH, outputToken, fee12)
        if (!p01 || !p12) continue
        const s01 = mockGetPool(p01)
        const s12 = mockGetPool(p12)
        if (!s01 || !s12) continue
        const mid   = estimateOutput(s01, inputToken, amountIn)
        const final = estimateOutput(s12, WETH, mid)
        if (final > bestOutput) {
          bestOutput = final
          bestRoute  = encodeTwoHop(inputToken, fee01, WETH, fee12, outputToken)
        }
      }
    }
  }

  if (!bestRoute || bestOutput < minOut) return null

  const { bidObj } = await buildBid(solverSigner, intent, {
    outputAmount: bestOutput.toString(),
    encodedRoute: bestRoute,
  })
  return { solverAddress: await solverSigner.getAddress(), outputAmount: bestOutput.toString(), encodedRoute: bestRoute, signature: bidObj.signature }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const dim  = s => `\x1b[2m${s}\x1b[0m`
const cyan = s => `\x1b[36m${s}\x1b[0m`
const grn  = s => `\x1b[32m${s}\x1b[0m`
const yel  = s => `\x1b[33m${s}\x1b[0m`
const bold = s => `\x1b[1m${s}\x1b[0m`
const hr   = () => console.log(dim('─'.repeat(60)))

// ── Main demo ─────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n' + bold('Gossamer — terminal demo'))
  console.log(dim('Private solver mesh. Intents settled before the chain sees them.\n'))

  await initCodec()

  // Wallets
  const userWallet   = ethers.Wallet.createRandom()
  const solver1      = ethers.Wallet.createRandom()
  const solver2      = ethers.Wallet.createRandom()
  const solver3      = ethers.Wallet.createRandom()

  // Token addresses
  const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
  const DAI  = '0x6B175474E89094C44Da98b954EedeAC495271d0F'

  // ── Step 1: User builds and signs intent ────────────────────────────────
  hr()
  console.log(bold('Step 1 — User signs intent'))
  console.log(dim(`  wallet: ${userWallet.address}`))

  const intentData = {
    user:            userWallet.address,
    nonce:           '0',
    inputToken:      USDC,
    outputToken:     DAI,
    inputAmount:     '1000000000',         // 1000 USDC
    minOutputAmount: '950000000000000000000', // 950 DAI min
    recipient:       userWallet.address,
    deadline:        Math.floor(Date.now() / 1000) + 600,
    topicTier:       0,
    preferredSolver: ethers.ZeroAddress,
  }

  const intentId = computeIntentId(intentData)
  const sig      = await userWallet.signTypedData(DOMAIN, INTENT_TYPE, intentData)
  const intent   = { ...intentData, intentId, signature: sig }

  console.log(cyan(`  intentId: ${intentId.slice(0, 18)}…`))
  console.log(dim(`  swap: 1000 USDC → DAI  |  min out: 950 DAI  |  window: 80ms`))

  // ── Step 2: Encode for gossip wire ──────────────────────────────────────
  hr()
  console.log(bold('Step 2 — Encode intent for GossipSub wire'))
  const wireBytes = await encodeIntent(intent)
  const jsonBytes = new TextEncoder().encode(JSON.stringify(intent)).length
  const saving = jsonBytes - wireBytes.length
  const pct = Math.round(saving / jsonBytes * 100)
  console.log(dim(`  protobuf: ${wireBytes.length}B  |  JSON equivalent: ${jsonBytes}B  |  saving: ${saving}B (${pct}% smaller)`))

  // ── Step 3: Three solvers receive + compute in parallel ─────────────────
  hr()
  console.log(bold('Step 3 — Solvers compute in parallel (mock RPC state)'))

  const solvers = [
    { name: 'Solver-A', wallet: solver1 },
    { name: 'Solver-B', wallet: solver2 },
    { name: 'Solver-C', wallet: solver3 },
  ]

  const auctionStart = Date.now()
  const bidResults = await Promise.allSettled(
    solvers.map(async ({ name, wallet }) => {
      const received = await decodeIntent(wireBytes)
      const sol      = await demoComputeSolution(wallet, received)
      if (!sol) return { name, bid: null }
      return { name, bid: { ...sol, solver: await wallet.getAddress() } }
    })
  )

  const bids = bidResults
    .filter(r => r.status === 'fulfilled' && r.value.bid)
    .map(r => r.value)

  const elapsed = Date.now() - auctionStart
  console.log(dim(`  ${bids.length}/${solvers.length} solvers returned bids  |  elapsed: ${elapsed}ms`))

  for (const { name, bid } of bids) {
    const route  = decodePath(bid.encodedRoute)
    const hops   = route.map(h => `${h.tokenIn.slice(0,6)}…→[${h.fee}]→${h.tokenOut.slice(0,6)}…`).join(' ')
    const outDAI = ethers.formatEther(bid.outputAmount)
    console.log(dim(`  ${name}: output=${yel(outDAI + ' DAI')}  route=${hops}  bytes=${bid.encodedRoute.length}B`))
  }

  // ── Step 4: Auction coordinator selects winner ──────────────────────────
  hr()
  console.log(bold('Step 4 — Auction coordinator selects winner'))

  const minOut = BigInt(intentData.minOutputAmount)
  const valid  = bids.filter(({ bid }) => BigInt(bid.outputAmount) >= minOut)
  valid.sort((a, b) => BigInt(b.bid.outputAmount) > BigInt(a.bid.outputAmount) ? 1 : -1)

  if (valid.length === 0) {
    console.log(yel('  No bids meet minOutputAmount — intent unmatched'))
    return
  }

  const { name: winnerName, bid: winnerBid } = valid[0]

  // Verify winning bid signature
  const recovered = verifyBid({
    intentId:     intent.intentId,
    solver:       winnerBid.solver,
    outputAmount: winnerBid.outputAmount,
    route:        winnerBid.encodedRoute instanceof Uint8Array
                    ? ethers.hexlify(winnerBid.encodedRoute)
                    : winnerBid.encodedRoute,
    deadline:     intent.deadline,
    signature:    winnerBid.signature,
  })
  const sigOk = recovered.toLowerCase() === winnerBid.solver.toLowerCase()

  console.log(grn(`  Winner: ${winnerName} (${winnerBid.solver.slice(0,12)}…)`))
  console.log(dim(`  Output: ${ethers.formatEther(winnerBid.outputAmount)} DAI`))
  console.log(dim(`  Route: ${decodePath(winnerBid.encodedRoute).length}-hop  |  ${winnerBid.encodedRoute.length}B encoded`))
  console.log(dim(`  Bid sig valid: ${sigOk ? grn('✓') : '✗'}`))

  // ── Step 5: Encode winning bid for RFQ stream ───────────────────────────
  hr()
  console.log(bold('Step 5 — Encode winning bid for RFQ stream wire'))

  const encodedWinnerBid = await encodeBid({
    intentId:     intent.intentId,
    solver:       winnerBid.solver,
    outputAmount: winnerBid.outputAmount,
    route:        winnerBid.encodedRoute,
    deadline:     intent.deadline,
    signature:    winnerBid.signature,
  })

  const decodedBack = await decodeBid(encodedWinnerBid)
  const rtOk = decodedBack.intentId === intent.intentId

  console.log(dim(`  Bid wire size: ${encodedWinnerBid.length}B`))
  console.log(dim(`  intentId round-trip: ${rtOk ? grn('✓') : '✗'}`))
  console.log(dim(`  → Solver ${winnerName} submits settlement tx to IntentSettlement.sol`))
  console.log(dim(`  → Contract verifies both sigs, executes swap, pays solver fee`))

  hr()
  console.log(bold('Demo complete'))
  console.log(dim('Next: Track 4.1 — IntentSettlement.sol on-chain verification + execution\n'))
}

main().catch(e => { console.error(e); process.exit(1) })