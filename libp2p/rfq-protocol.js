// /defi/rfq/1.0.0 stream protocol
// Direct encrypted solver negotiation over yamux streams.
// Wire format: [4-byte big-endian uint32 length] + [protobuf payload]
import { encodeIntent, encodeBid, decodeBid, decodeIntent } from '../sdk/intent-codec.js'

export const RFQ_PROTOCOL = '/defi/rfq/1.0.0'

// ── Byte framing helpers ──────────────────────────────────────────────────────

// Write a length-prefixed message into a stream sink
async function writeFramed(stream, payload) {
  const frame = new Uint8Array(4 + payload.length)
  const view  = new DataView(frame.buffer)
  view.setUint32(0, payload.length, false)  // big-endian uint32
  frame.set(payload, 4)
  await stream.sink([frame])
}

// Read exactly n bytes from an async-iterable stream source.
// Loops across chunks — chunks have no guaranteed boundary alignment.
async function readExact(source, n) {
  const buf = new Uint8Array(n)
  let offset = 0
  for await (const chunk of source) {
    const bytes  = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
    const needed = n - offset
    if (bytes.length >= needed) {
      buf.set(bytes.subarray(0, needed), offset)
      return buf          // accumulated enough — done
    }
    buf.set(bytes, offset)
    offset += bytes.length  // need more chunks — keep reading
  }
  throw new Error(`Stream ended after ${offset} bytes, expected ${n}`)
}

// Read one length-prefixed frame from a stream source
async function readFramed(source) {
  const lenBuf = await readExact(source, 4)
  const length = new DataView(lenBuf.buffer).getUint32(0, false)  // big-endian
  if (length === 0 || length > 1_048_576) {
    throw new Error(`Invalid frame length: ${length}`)             // sanity: 0 < len < 1MB
  }
  return readExact(source, length)
}

// ── Solver side — incoming RFQ handler ───────────────────────────────────────

/**
 * Register the /defi/rfq/1.0.0 handler on a solver node.
 *
 * computeSolution is injected from solver.js — keeps this file DEX-agnostic.
 * Signature: async (intent) => { solverAddress, outputAmount, encodedRoute, signature } | null
 */
export function registerRFQHandler(node, computeSolution) {
  node.handle(RFQ_PROTOCOL, async ({ stream, connection }) => {
    const peerId = connection.remotePeer.toString()
    try {
      // 1. Read length-prefixed intent
      const intentBytes = await readFramed(stream.source)
      const intent      = await decodeIntent(intentBytes)

      // 2. Delegate to injected compute engine (Track 3.3)
      const solution = await computeSolution(intent)

      if (!solution) {
        // Cannot fill — close without a bid; coordinator treats as timeout
        await stream.close()
        return
      }

      // 3. Write length-prefixed bid back
      const bidPayload = await encodeBid({
        intentId:     intent.intentId,
        solver:       solution.solverAddress,
        outputAmount: solution.outputAmount,
        route:        solution.encodedRoute,
        deadline:     intent.deadline,
        signature:    solution.signature,
      })

      await writeFramed(stream, bidPayload)
      await stream.close()

    } catch (err) {
      console.warn(`[rfq] handler error from ${peerId.slice(0, 12)}:`, err.message)
      try { await stream.abort(err) } catch {}
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

    // Half-close write side — solver knows intent is complete, starts computing
    if (typeof stream.closeWrite === 'function') await stream.closeWrite()

    // 2. Read bid
    const bidBytes = await readFramed(stream.source)
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