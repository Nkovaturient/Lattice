#!/usr/bin/env node
// scripts/settle.js — Submit winning bid to IntentSettlement.sol on Arbitrum Sepolia
// Called by the winning solver after auction:winner event fires.
// Usage:
//   PRIVATE_KEY=0x... ARB_SEPOLIA_RPC=https://... \
//   SETTLEMENT_CONTRACT_ADDRESS=0x... \
//   INTENT_JSON='{...}' BID_JSON='{...}' \
//   node scripts/settle.js

import { ethers } from 'ethers'

const {
  PRIVATE_KEY,
  ARB_SEPOLIA_RPC,
  SETTLEMENT_CONTRACT_ADDRESS,
  INTENT_JSON,
  BID_JSON,
} = process.env

if (!PRIVATE_KEY || !ARB_SEPOLIA_RPC || !SETTLEMENT_CONTRACT_ADDRESS || !INTENT_JSON || !BID_JSON) {
  console.error('Required: PRIVATE_KEY, ARB_SEPOLIA_RPC, SETTLEMENT_CONTRACT_ADDRESS, INTENT_JSON, BID_JSON')
  process.exit(1)
}

// ── Settlement ABI ────────────────────────────────────────────────────────────
const SETTLEMENT_ABI = [
  `function settle(
    tuple(address user, uint256 nonce, address inputToken, address outputToken,
          uint256 inputAmount, uint256 minOutputAmount, address recipient,
          uint64 deadline, uint8 topicTier, address preferredSolver) intent,
    bytes intentSig,
    tuple(bytes32 intentId, address solver, uint256 outputAmount,
          bytes route, uint64 deadline) bid,
    bytes bidSig
  ) external`,
  'function settled(bytes32) view returns (bool)',
  'event IntentSettled(bytes32 indexed intentId, address indexed user, address indexed solver, uint256 inputAmount, uint256 outputAmount, uint256 solverFee)',
]

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
]

async function main() {
  const provider   = new ethers.JsonRpcProvider(ARB_SEPOLIA_RPC)
  const signer     = new ethers.Wallet(PRIVATE_KEY, provider)
  const network    = await provider.getNetwork()
  const settlement = new ethers.Contract(SETTLEMENT_CONTRACT_ADDRESS, SETTLEMENT_ABI, signer)

  const intentObj = JSON.parse(INTENT_JSON)
  const bidObj    = JSON.parse(BID_JSON)

  console.log(`[settle] chain:    ${network.name} (${network.chainId})`)
  console.log(`[settle] solver:   ${signer.address}`)
  console.log(`[settle] intentId: ${bidObj.intentId?.slice(0, 18)}…`)
  console.log(`[settle] output:   ${bidObj.outputAmount}`)

  // ── Check not already settled ─────────────────────────────────────────────
  const alreadySettled = await settlement.settled(bidObj.intentId)
  if (alreadySettled) {
    console.error('[settle] intent already settled — aborting')
    process.exit(1)
  }

  // ── Check intent deadline ─────────────────────────────────────────────────
  const now = Math.floor(Date.now() / 1000)
  if (now >= intentObj.deadline) {
    console.error(`[settle] intent expired (deadline: ${intentObj.deadline}, now: ${now})`)
    process.exit(1)
  }
  console.log(`[settle] deadline ok — ${intentObj.deadline - now}s remaining`)

  // ── Approve inputToken transfer ───────────────────────────────────────────
  const token = new ethers.Contract(intentObj.inputToken, ERC20_ABI, signer)
  const allowance = await token.allowance(intentObj.user, SETTLEMENT_CONTRACT_ADDRESS)

  if (allowance < BigInt(intentObj.inputAmount)) {
    console.log(`[settle] approving inputToken...`)
    // Note: in production this tx is submitted by the USER's wallet, not solver
    // The user must approve before the intent is broadcast
    console.warn('[settle] user must approve inputToken to settlement contract first')
    console.warn(`  token:    ${intentObj.inputToken}`)
    console.warn(`  spender:  ${SETTLEMENT_CONTRACT_ADDRESS}`)
    console.warn(`  amount:   ${intentObj.inputAmount}`)
  }

  // ── Submit settlement tx ──────────────────────────────────────────────────
  const intentTuple = [
    intentObj.user,
    intentObj.nonce,
    intentObj.inputToken,
    intentObj.outputToken,
    intentObj.inputAmount,
    intentObj.minOutputAmount,
    intentObj.recipient,
    intentObj.deadline,
    intentObj.topicTier,
    intentObj.preferredSolver,
  ]

  const bidTuple = [
    bidObj.intentId,
    bidObj.solver,
    bidObj.outputAmount,
    bidObj.route,   // hex-encoded Uniswap v3 path
    bidObj.deadline,
  ]

  console.log('[settle] estimating gas...')
  let gasEstimate
  try {
    gasEstimate = await settlement.settle.estimateGas(
      intentTuple, intentObj.signature,
      bidTuple,    bidObj.signature
    )
    console.log(`[settle] gas estimate: ${gasEstimate}`)
  } catch (e) {
    console.error('[settle] gas estimation failed:', e.message)
    console.error('[settle] likely cause: user token not approved, or intent already filled')
    process.exit(1)
  }

  const gasPrice = (await provider.getFeeData()).gasPrice
  const gasCost  = ethers.formatEther(gasEstimate * gasPrice)
  console.log(`[settle] estimated cost: ${gasCost} ETH`)

  console.log('[settle] submitting tx...')
  const tx = await settlement.settle(
    intentTuple, intentObj.signature,
    bidTuple,    bidObj.signature,
    { gasLimit: gasEstimate * 120n / 100n }  // 20% buffer
  )

  console.log(`[settle] tx submitted: ${tx.hash}`)
  console.log(`[settle] arbiscan: https://sepolia.arbiscan.io/tx/${tx.hash}`)

  const receipt = await tx.wait()
  console.log(`[settle] confirmed in block ${receipt.blockNumber}`)
  console.log(`[settle] gas used: ${receipt.gasUsed}`)

  // ── Parse IntentSettled event ─────────────────────────────────────────────
  const iface  = new ethers.Interface(SETTLEMENT_ABI)
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog(log)
      if (parsed?.name === 'IntentSettled') {
        console.log('\n[settle] IntentSettled event:')
        console.log(`  intentId:  ${parsed.args.intentId}`)
        console.log(`  user:      ${parsed.args.user}`)
        console.log(`  solver:    ${parsed.args.solver}`)
        console.log(`  input:     ${parsed.args.inputAmount}`)
        console.log(`  output:    ${parsed.args.outputAmount}`)
        console.log(`  solverFee: ${parsed.args.solverFee}`)
      }
    } catch {}
  }
}

main().catch(e => { console.error(e.message); process.exit(1) })