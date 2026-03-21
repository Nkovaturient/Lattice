// Track 2.1 — User-facing intent builder + EIP-712 signer
import { ethers } from 'ethers'
import { DOMAIN, INTENT_TYPE } from './domain.js'
import { computeIntentId, intentWithoutSig } from './intent-id.js'

// ── Protocol constants (not user-configurable) ────────────────────────────────
export const PROTOCOL = {
  AUCTION_WINDOW_MS:       80,   // fixed auction window — solvers hard-code to this
  MAX_DEADLINE_OFFSET_SEC: 600,  // 10 min — max intent lifetime
  MIN_DEADLINE_OFFSET_SEC: 60,   // must survive until settlement tx lands
}

// ── Main builder ──────────────────────────────────────────────────────────────
export async function buildAndSignIntent(signer, params, settlementContract) {
  const userAddr = await signer.getAddress()
  const nonce    = await settlementContract.nonces(userAddr)

  const intentData = {
    user:            userAddr,
    nonce:           nonce.toString(),
    inputToken:      params.inputToken,
    outputToken:     params.outputToken,
    inputAmount:     params.inputAmount.toString(),
    minOutputAmount: params.minOutputAmount.toString(),
    recipient:       params.recipient ?? userAddr,
    deadline:        Math.floor(Date.now() / 1000) + PROTOCOL.MAX_DEADLINE_OFFSET_SEC,
    topicTier:       params.topicTier ?? 0,
    preferredSolver: params.preferredSolver ?? ethers.ZeroAddress,
  }

  _validateParams(intentData)

  const signature = await signer.signTypedData(DOMAIN, INTENT_TYPE, intentData)
  const intentId  = computeIntentId(intentData)

  return { ...intentData, intentId, signature }
}

// ── Param validation (throws on bad input) ────────────────────────────────────
function _validateParams(d) {
  if (BigInt(d.inputAmount) <= 0n)
    throw new Error('inputAmount must be > 0')
  if (BigInt(d.minOutputAmount) <= 0n)
    throw new Error('minOutputAmount must be > 0')
  if (d.inputToken.toLowerCase() === d.outputToken.toLowerCase())
    throw new Error('inputToken and outputToken must differ')
  if (![0, 1].includes(Number(d.topicTier)))
    throw new Error('topicTier must be 0 (public) or 1 (tier-1)')
}