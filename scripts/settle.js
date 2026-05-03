#!/usr/bin/env node
// CLI: submit winning bid to IntentSettlement (Arbitrum Sepolia / One).
// Loads .env from cwd. Example:
//   INTENT_JSON='{"user":"0x..."}' BID_JSON='{"intentId":"0x...",...}' node scripts/settle.js
import 'dotenv/config'
import { ethers } from 'ethers'
import { submitSettlement } from '../node/settlement-submit.js'

const {
  PRIVATE_KEY,
  ARB_SEPOLIA_RPC,
  ARB_MAINNET_RPC,
  CHAIN_ID,
  ARB_SEPOLIA_CHAIN_ID,
  SETTLEMENT_CONTRACT_ADDRESS,
  INTENT_SETTLEMENT_ADDRESS,
  INTENT_JSON,
  BID_JSON,
} = process.env

const rpc = ARB_SEPOLIA_RPC || ARB_MAINNET_RPC
const settlementAddr = (SETTLEMENT_CONTRACT_ADDRESS ?? INTENT_SETTLEMENT_ADDRESS)?.trim()

if (!PRIVATE_KEY || !rpc || !settlementAddr || !INTENT_JSON || !BID_JSON) {
  console.error(
    'Required: PRIVATE_KEY, ARB_SEPOLIA_RPC or ARB_MAINNET_RPC, SETTLEMENT_CONTRACT_ADDRESS (or INTENT_SETTLEMENT_ADDRESS), INTENT_JSON, BID_JSON'
  )
  process.exit(1)
}

const chainIdHint = CHAIN_ID ?? ARB_SEPOLIA_CHAIN_ID
const provider =
  chainIdHint != null && String(chainIdHint).trim() !== ''
    ? new ethers.JsonRpcProvider(rpc, Number(chainIdHint))
    : new ethers.JsonRpcProvider(rpc)

async function main() {
  const signer = new ethers.Wallet(PRIVATE_KEY, provider)
  const intent = JSON.parse(INTENT_JSON)
  const bid = JSON.parse(BID_JSON)

  if (bid.route && typeof bid.route === 'string' && bid.route.startsWith('0x')) {
    bid.route = ethers.getBytes(bid.route)
  }

  console.log(`[settle] solver ${signer.address}`)
  await submitSettlement({
    provider,
    signer,
    settlementContractAddress: settlementAddr,
    intent,
    bid,
  })
}

main().catch(e => {
  console.error('[settle]', e.shortMessage ?? e.message)
  process.exit(1)
})
