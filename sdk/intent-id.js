// Track 2.1 — intentId computation + GossipSub messageIdFn
import { ethers } from 'ethers'
import { DOMAIN, INTENT_TYPE } from './domain.js'
import { decodeIntentSync } from './intent-codec.js'

export function computeIntentId(intentData) {
  return ethers.TypedDataEncoder.hash(DOMAIN, INTENT_TYPE, intentData)
}

// GossipSub messageIdFn — runs on every incoming message, must be sync + fast
// Safe because initCodec() is called at node startup before any messages arrive
export function intentMessageId(msg) {
  try {
    const intent = decodeIntentSync(msg.data)
    return ethers.getBytes(intent.intentId)
  } catch {
    // Fallback: hash the raw bytes — prevents GossipSub from crashing on bad msgs
    return ethers.getBytes(ethers.keccak256(msg.data))
  }
}

// Strip signature + intentId before EIP-712 verification / hashing
export function intentWithoutSig(intent) {
  const { signature, intentId, ...rest } = intent
  return rest
}