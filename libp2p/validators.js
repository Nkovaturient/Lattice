// Track 2.3 / 5.2 — GossipSub topic validators + propagation jitter
// Jitter added to forwarding defeats timing-based origin fingerprinting.
import { TopicValidatorResult } from '@libp2p/interface'
import { ethers } from 'ethers'
import { TOPICS } from './topics.js'
import { DOMAIN, INTENT_TYPE } from '../sdk/domain.js'
import { decodeIntent } from '../sdk/intent-codec.js'
import { computeIntentId, intentWithoutSig } from '../sdk/intent-id.js'

// ── Propagation jitter — Track 5.2 MEV mitigation ────────────────────────────
// Random 0–15ms delay before forwarding any valid intent.
// Prevents timing correlation attacks that could fingerprint the origin node.
// 15ms ceiling is safe: worst case adds 15ms to propagation, still inside 80ms budget.
const JITTER_MAX_MS = 15

function propagationJitter() {
  return new Promise(resolve =>
    setTimeout(resolve, Math.random() * JITTER_MAX_MS)
  )
}

// ── Validators ────────────────────────────────────────────────────────────────

export function attachIntentValidators(node, registryCache) {
  node.services.pubsub.topicValidators.set(
    TOPICS.PUBLIC,
    (peerId, msg) => _validate(msg, { tierCheck: false })
  )
  node.services.pubsub.topicValidators.set(
    TOPICS.TIER1,
    (peerId, msg) => _validate(msg, { tierCheck: true, peerId }, registryCache)
  )
}

async function _validate(msg, options, registryCache) {
  // Step 1 — decode (~0.1ms)
  let intent
  try { intent = await decodeIntent(msg.data) }
  catch { return TopicValidatorResult.Reject }

  // Step 2 — intentId format (~0.05ms)
  if (!intent.intentId || ethers.getBytes(intent.intentId).length !== 32)
    return TopicValidatorResult.Reject

  // Step 3 — deadline not expired (~0.05ms)
  if (Math.floor(Date.now() / 1000) >= intent.deadline)
    return TopicValidatorResult.Reject

  // Step 4 — EIP-712 signature (~0.5ms)
  let recovered
  try {
    recovered = ethers.verifyTypedData(
      DOMAIN, INTENT_TYPE, intentWithoutSig(intent), intent.signature
    )
  } catch { return TopicValidatorResult.Reject }

  if (recovered.toLowerCase() !== intent.user.toLowerCase())
    return TopicValidatorResult.Reject

  // Step 5 — intentId integrity (~0.5ms)
  if (computeIntentId(intentWithoutSig(intent)) !== intent.intentId)
    return TopicValidatorResult.Reject

  // Step 6 — tier-1 registry check (~0.1ms cache hit)
  if (options.tierCheck) {
    const ok = await registryCache?.isSolverRegistered(options.peerId)
    if (!ok) return TopicValidatorResult.Reject
  }

  // Step 7 — propagation jitter (0–15ms) — MEV timing attack mitigation
  // Applied AFTER all validation passes — invalid messages are rejected instantly
  await propagationJitter()

  return TopicValidatorResult.Accept
}