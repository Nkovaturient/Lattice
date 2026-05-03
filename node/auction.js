// Auction coordinator with commit-reveal (MEV-resistant)
// Listens for intents via GossipSub, runs two-phase commit-reveal auction when
// peer solvers exist, otherwise optional localCompute (single-solver mesh).
import { decodeIntent } from '../sdk/intent-codec.js'
import { verifyBid } from '../sdk/bid-builder.js'
import { TOPICS } from '../libp2p/topics.js'
import { CommitRevealAuction } from '../libp2p/commitment.js'

// ── Auction coordinator ───────────────────────────────────────────────────────

/**
 * Attach the auction coordinator to a running libp2p node.
 *
 * When solverPeers is non-empty — commit-reveal RFQ to peers.
 * When solverPeers is empty — if localCompute is set, computes on this node
 *   only (solo solver / bootstrap demo). Uses same bid verification rules.
 *
 * config shape:
 * {
 *   solverPeers:   PeerId[],
 *   localCompute?: async (intent) => { solverAddress, outputAmount, encodedRoute, signature } | null
 *   onWinner:      async (bid, intent) => void,
 *   selfAddress:   string — EVM address (reserved for peer filtering; use peer IDs for exclusions)
 * }
 */
export function attachAuctionCoordinator(node, config) {
  const { solverPeers = [], onWinner, selfAddress, localCompute } = config

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
    _runAuction(node, intent, solverPeers, selfAddress, localCompute, onWinner)
      .catch(err => console.warn('[auction] unhandled error:', err.message))
  })

  console.log('[auction] coordinator attached')
}

function _solutionToBid(solution, intent) {
  if (!solution) return null
  const {
    solverAddress,
    outputAmount,
    encodedRoute,
    signature,
    route,
  } = solution
  return {
    intentId: intent.intentId,
    solver: solverAddress ?? solution.solver,
    outputAmount: String(outputAmount),
    route: route ?? encodedRoute,
    deadline: intent.deadline,
    signature,
  }
}

// ── Core auction logic ────────────────────────────────────────────────────────

async function _runAuction(node, intent, solverPeers, selfAddress, localCompute, onWinner) {
  const auctionStart = Date.now()
  const intentShort  = intent.intentId.slice(0, 14)

  const targets = solverPeers.filter(peerId => {
    return peerId.toString() !== (selfAddress ?? '')
  })

  let revealedBids = []

  if (targets.length > 0) {
    console.log(`[auction] ${intentShort}… — commit-reveal with ${targets.length} remote solver(s)`)

    const auction = new CommitRevealAuction(node, intent, targets)
    revealedBids = await auction.run()
  } else if (typeof localCompute === 'function') {
    console.log(`[auction] ${intentShort}… — local solver compute (solo mesh)`)

    try {
      const solution = await localCompute(intent)
      const bid      = _solutionToBid(solution, intent)
      if (bid) revealedBids = [bid]
    } catch (err) {
      console.warn(`[auction] ${intentShort}… — localCompute error: ${err.message}`)
      return
    }
  } else {
    console.warn(`[auction] ${intentShort}… — no solver peers and no localCompute — ignoring intent`)
    return
  }

  const elapsed = Date.now() - auctionStart
  console.log(`[auction] ${intentShort}… — closed at ${elapsed}ms, ${revealedBids.length} bid(s)`)

  if (revealedBids.length === 0) {
    console.warn(`[auction] ${intentShort}… — no valid bid, intent unmatched`)
    return
  }

  // Select winner from revealed bids
  const winner = _selectWinnerFromReveals(revealedBids, intent)
  if (!winner) {
    console.warn(`[auction] ${intentShort}… — all bids failed verification or min output`)
    return
  }

  console.log(`[auction] ${intentShort}… — winner: solver ${winner.solver.slice(0, 12)}… output: ${winner.outputAmount}`)

  // Hand off to settlement callback (solver submits the tx)
  if (typeof onWinner === 'function') {
    try {
      await onWinner(winner, intent)
    } catch (e) {
      console.warn('[auction] onWinner/settlement:', e.shortMessage ?? e.message)
    }
  }
}

// ── Bid selection from revealed bids ──────────────────────────────────────────

/**
 * Select the winning bid from revealed bids (commit-reveal phase 2 results).
 *
 * Rules (in order):
 *   1. Verify EIP-712 signature — reject any bid with invalid sig
 *   2. Reject bids with outputAmount < intent.minOutputAmount
 *   3. Highest outputAmount wins
 */
function _selectWinnerFromReveals(revealedBids, intent) {
  const minOut = BigInt(intent.minOutputAmount)

  const valid = revealedBids.filter(bid => {
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

  // Step 3 — sort by outputAmount desc (no tie-break needed — commit-reveal ensures fairness)
  valid.sort((a, b) => {
    const diff = BigInt(b.outputAmount) - BigInt(a.outputAmount)
    return diff > 0n ? 1 : diff < 0n ? -1 : 0
  })

  return valid[0]
}