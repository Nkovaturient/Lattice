// Track 3.2 — Auction coordinator
// Listens for intents via GossipSub, fans out RFQ streams to all solver peers
// in parallel, enforces the 80ms hard deadline, selects the winning bid,
// and emits it for settlement submission (solver submits the tx — Track 4.1).
import { decodeIntent } from '../sdk/intent-codec.js'
import { verifyBid } from '../sdk/bid-builder.js'
import { requestBid } from '../libp2p/rfq-protocol.js'
import { TOPICS } from '../libp2p/topics.js'
import { PROTOCOL } from '../config/protocol.js'

// ── Auction coordinator ───────────────────────────────────────────────────────

/**
 * Attach the auction coordinator to a running libp2p node.
 *
 * Listens on both GossipSub topics. When an intent arrives:
 *   1. Fan out RFQ streams to all known solver peers in parallel
 *   2. Hard-close the auction after AUCTION_WINDOW_MS (80ms)
 *   3. Verify + rank bids — highest outputAmount wins
 *   4. Emit 'auction:winner' event with the winning bid
 *
 * config shape:
 * {
 *   solverPeers: PeerId[],          // pre-warmed solver peer IDs to RFQ
 *   onWinner:    async (bid, intent) => void,  // settlement callback
 *   selfAddress: string,            // this node's EVM address — skip self-RFQ
 * }
 */
export function attachAuctionCoordinator(node, config) {
  const { solverPeers = [], onWinner, selfAddress } = config

  // Handle messages on both public and tier-1 topics
  node.services.pubsub.addEventListener('message', async (evt) => {
    const { topic, data } = evt.detail

    if (topic !== TOPICS.PUBLIC && topic !== TOPICS.TIER1) return

    let intent
    try {
      intent = await decodeIntent(data)
    } catch {
      return  // malformed — validator should have caught this, but be safe
    }

    // Don't auction intents that are already expired
    if (Math.floor(Date.now() / 1000) >= intent.deadline) return

    // Kick off the auction — non-blocking, errors contained inside
    _runAuction(node, intent, solverPeers, selfAddress, onWinner)
      .catch(err => console.warn('[auction] unhandled error:', err.message))
  })

  console.log('[auction] coordinator attached')
}

// ── Core auction logic ────────────────────────────────────────────────────────

async function _runAuction(node, intent, solverPeers, selfAddress, onWinner) {
  const auctionStart = Date.now()
  const intentShort  = intent.intentId.slice(0, 14)

  // Filter out self (coordinator might also be a solver) and empty list
  const targets = solverPeers.filter(peerId => {
    return peerId.toString() !== (selfAddress ?? '')
  })

  if (targets.length === 0) {
    console.warn(`[auction] ${intentShort}… — no solver peers to RFQ`)
    return
  }

  console.log(`[auction] ${intentShort}… — fanning out to ${targets.length} solvers`)

  // Fan out all RFQ streams in parallel — each has its own 60ms AbortSignal
  const bidPromises = targets.map(peerId => requestBid(node, peerId, intent))

  // Hard deadline: race allSettled against the 80ms wall clock
  // If the timer fires first, we work with whatever bids have arrived so far
  const bids = await _raceWithDeadline(bidPromises, PROTOCOL.AUCTION_WINDOW_MS)

  const elapsed = Date.now() - auctionStart
  console.log(`[auction] ${intentShort}… — closed at ${elapsed}ms, ${bids.length} bids received`)

  if (bids.length === 0) {
    console.warn(`[auction] ${intentShort}… — no bids, intent unmatched`)
    return
  }

  // Select winner
  const winner = _selectWinner(bids, intent)
  if (!winner) {
    console.warn(`[auction] ${intentShort}… — all bids failed verification`)
    return
  }

  console.log(`[auction] ${intentShort}… — winner: solver ${winner.solver.slice(0, 12)}… output: ${winner.outputAmount}`)

  // Hand off to settlement callback (solver submits the tx in Track 4.1)
  if (typeof onWinner === 'function') {
    await onWinner(winner, intent)
  }
}

// ── Deadline enforcement ──────────────────────────────────────────────────────

/**
 * Race Promise.allSettled against a hard deadline timer.
 * Returns all bids that arrived before whichever fires first.
 *
 * Key design: we don't cancel in-flight RFQ streams when the timer fires —
 * requestBid() has its own 60ms AbortSignal. The deadline here only controls
 * how long the coordinator waits before selecting a winner.
 */
async function _raceWithDeadline(bidPromises, windowMs) {
  // Track bids as they arrive
  const settled = []
  const wrappedPromises = bidPromises.map(p =>
    p.then(bid  => { if (bid) settled.push({ bid, arrivedAt: Date.now() }) })
     .catch(() => {})  // null bids from requestBid() are already handled
  )

  // The deadline resolves after windowMs regardless
  const deadline = new Promise(resolve => setTimeout(resolve, windowMs))

  // Whichever fires first: all bids in or time's up
  await Promise.race([
    Promise.allSettled(wrappedPromises),
    deadline,
  ])

  return settled.map(({ bid, arrivedAt }) => ({ ...bid, _arrivedAt: arrivedAt }))
}

// ── Bid selection ─────────────────────────────────────────────────────────────

/**
 * Select the winning bid from the set of received bids.
 *
 * Rules (in order):
 *   1. Verify EIP-712 signature — reject any bid with invalid sig
 *   2. Reject bids with outputAmount < intent.minOutputAmount
 *   3. Highest outputAmount wins
 *   4. Tie-break: earliest arrival time (_arrivedAt)
 */
function _selectWinner(bids, intent) {
  const minOut = BigInt(intent.minOutputAmount)

  const valid = bids.filter(bid => {
    // Step 1 — signature check
    try {
      const recovered = verifyBid(bid)
      if (recovered.toLowerCase() !== bid.solver.toLowerCase()) return false
    } catch {
      return false
    }

    // Step 2 — output floor
    if (BigInt(bid.outputAmount) < minOut) return false

    return true
  })

  if (valid.length === 0) return null

  // Step 3+4 — sort by outputAmount desc, then arrival time asc
  valid.sort((a, b) => {
    const diff = BigInt(b.outputAmount) - BigInt(a.outputAmount)
    if (diff !== 0n) return diff > 0n ? 1 : -1  // higher output first
    return a._arrivedAt - b._arrivedAt           // earlier arrival as tie-break
  })

  // Strip internal tracking field before returning
  const { _arrivedAt, ...winner } = valid[0]
  return winner
}