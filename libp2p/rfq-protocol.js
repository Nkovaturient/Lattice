// /defi/rfq/1.0.0 stream protocol
// Direct encrypted solver negotiation over yamux streams.
// Wire format: [4-byte big-endian uint32 length] + [protobuf payload]
import { ethers } from 'ethers'
import { encodeIntent, encodeBid, decodeBid, decodeIntent } from '../sdk/intent-codec.js'
import { createCommitment } from './commitment.js'
import { writeFramed, readFramed, closeStreamWrite } from './rfq-internal.js'

export const RFQ_PROTOCOL = '/defi/rfq/1.0.0'

// ── Solver side — incoming RFQ handler ───────────────────────────────────────

/**
 * Register the /defi/rfq/1.0.0 handler on a solver node.
 *
 * computeSolution is injected from solver.js — keeps this file DEX-agnostic.
 * Signature: async (intent) => { solverAddress, outputAmount, encodedRoute, signature } | null
 */
async function _writeSimpleBid(stream, intent, solution) {
  const bidPayload = await encodeBid({
    intentId:     intent.intentId,
    solver:       solution.solverAddress,
    outputAmount: solution.outputAmount,
    route:        solution.encodedRoute,
    deadline:     intent.deadline,
    signature:    solution.signature,
  })
  await writeFramed(stream, bidPayload)
}

async function _writeCommitReveal(stream, intent, solution) {
  const route = solution.encodedRoute
  const bidForCommit = {
    intentId:     intent.intentId,
    outputAmount: solution.outputAmount,
    route,
  }
  const { commitment, salt } = createCommitment(bidForCommit)

  await writeFramed(stream, ethers.getBytes(commitment))

  const revealSignal = await readFramed(stream)
  if (new TextDecoder().decode(revealSignal) !== 'REVEAL') {
    throw new Error('Expected REVEAL signal')
  }

  const bidPayload = await encodeBid({
    intentId:     intent.intentId,
    solver:       solution.solverAddress,
    outputAmount: solution.outputAmount,
    route,
    deadline:     intent.deadline,
    signature:    solution.signature,
  })

  const revealBytes = new Uint8Array(4 + bidPayload.length + 32)
  new DataView(revealBytes.buffer).setUint32(0, bidPayload.length, false)
  revealBytes.set(bidPayload, 4)
  revealBytes.set(salt, 4 + bidPayload.length)
  await writeFramed(stream, revealBytes)
}

/**
 * @param {{ commitReveal?: boolean }} [options]
 *   commitReveal=true — two-phase hash-then-reveal (multi-solver auction)
 */
export function registerRFQHandler(node, computeSolution, options = {}) {
  const { commitReveal = false } = options

  node.handle(RFQ_PROTOCOL, async (stream, connection) => {
    const peerId = connection.remotePeer.toString()
    try {
      const intentBytes = await readFramed(stream)
      const intent      = await decodeIntent(intentBytes)
      const solution    = await computeSolution(intent)

      if (!solution) {
        await stream.close()
        return
      }

      if (commitReveal) {
        await _writeCommitReveal(stream, intent, solution)
      } else {
        await _writeSimpleBid(stream, intent, solution)
      }
      await stream.close()

    } catch (err) {
      console.warn(`[rfq] handler error from ${peerId.slice(0, 12)}:`, err.message)
      try { stream.abort(err) } catch {}
    }
  })
}

// ── Transport-aware RFQ timeout ───────────────────────────────────────────────

/**
 * RFQ_DIAL_TIMEOUT_MS defaults:
 *   WebSocket cold dial ~50ms → 60ms budget leaves 20ms coordinator window.
 *   QUIC 0-RTT cold dial ~30ms → 40ms budget leaves ~40ms coordinator window.
 *   Set RFQ_DIAL_TIMEOUT_MS in env to override for either transport.
 *   When Phase 6.2 (QUIC transport) lands, lower the per-connection default
 *   based on resolved transport at dial time.
 */
const RFQ_DIAL_TIMEOUT_MS = Number(process.env.RFQ_DIAL_TIMEOUT_MS ?? 60)

// Pre-warm tracking: record last successful dial time per peer.
// Used for future per-peer adaptive timeout (QUIC Phase 6.2 hook point).
const _lastDialMs = new Map()

export function recordDialSuccess(peerId) {
  _lastDialMs.set(peerId.toString(), Date.now())
}

export function isConnectionPreWarmed(peerId) {
  return _lastDialMs.has(peerId.toString())
}

// ── Coordinator side — outbound RFQ to one solver ────────────────────────────

/**
 * Open a /defi/rfq/1.0.0 stream to a single solver, send the intent,
 * and return the decoded bid — or null on timeout / any error.
 *
 * Called in parallel across all solver peers by auction.js (Track 3.2).
 * Timeout is env-configurable via RFQ_DIAL_TIMEOUT_MS (default 60ms for WS,
 * ~40ms recommended for QUIC once Phase 6.2 lands).
 */
export async function requestBid(node, peerId, intent) {
  let stream
  try {
    // Reuses pre-warmed Noise connection (~2ms). Cold WS dial = ~50ms = budget bust.
    stream = await node.dialProtocol(peerId, RFQ_PROTOCOL, {
      signal: AbortSignal.timeout(RFQ_DIAL_TIMEOUT_MS),
    })
    recordDialSuccess(peerId)

    // 1. Send intent
    const intentBytes = await encodeIntent(intent)
    await writeFramed(stream, intentBytes)

    await closeStreamWrite(stream)

    const bidBytes = await readFramed(stream)
    const bid      = await decodeBid(bidBytes)

    // 3. Basic integrity checks
    if (bid.intentId !== intent.intentId) {
      throw new Error('Bid intentId mismatch')
    }
    if (Number(bid.deadline) < Math.floor(Date.now() / 1000)) {
      throw new Error('Bid deadline expired')
    }

    await stream.close()
    return bid

  } catch (err) {
    if (stream) try { await stream.abort(err) } catch {}
    console.warn(`[rfq] no bid from ${peerId.toString().slice(0, 12)}:`, err.message)
    return null
  }
}