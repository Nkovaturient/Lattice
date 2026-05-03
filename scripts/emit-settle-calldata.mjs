#!/usr/bin/env node
/**
 * Emit hex calldata for IntentSettlement.settle(...) from INTENT_JSON.
 *
 * Usage:
 *   INTENT_JSON=./mesh-snapshot.json node scripts/emit-settle-calldata.mjs
 *
 * Requires CHAIN_ID + INTENT_SETTLEMENT_ADDRESS / SETTLEMENT_CONTRACT_ADDRESS
 * in the environment so sdk/domain.js matches the chain (same as solver).
 */
import 'dotenv/config'
import { ethers } from 'ethers'
import { readFileSync, existsSync } from 'fs'
import { IntentSettlementABI } from '../ABI/IntentSettlementABI.js'
import { buildSettleArgs } from '../node/settlement-preflight.js'

const path = process.env.INTENT_JSON?.trim()
if (!path || !existsSync(path)) {
  console.error('Set INTENT_JSON to a file path containing { "intent", "bid" }.')
  process.exit(2)
}

const { intent, bid } = JSON.parse(readFileSync(path, 'utf8'))
const iface = new ethers.Interface(IntentSettlementABI)
const data = iface.encodeFunctionData('settle', buildSettleArgs(intent, bid))
process.stdout.write(data)
