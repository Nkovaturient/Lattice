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

// ── Coordinator side — outbound RFQ to one solver ────────────────────────────

/**
 * Open a /defi/rfq/1.0.0 stream to a single solver, send the intent,
 * and return the decoded bid — or null on timeout / any error.
 *
 * Called in parallel across all solver peers by auction.js (Track 3.2).
 * 60ms AbortSignal leaves 20ms for the coordinator to select the winner.
 */
export async function requestBid(node, peerId, intent) {
  let stream
  try {
    // Reuses pre-warmed Noise connection (~2ms). Cold dial = ~50ms = budget bust.
    stream = await node.dialProtocol(peerId, RFQ_PROTOCOL, {
      signal: AbortSignal.timeout(60),
    })

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