// src/p2p/commitment.js — Track 5.2
// Two-phase commit-reveal scheme preventing late bid sniping.
//
// Phase 1 (0–60ms): solvers broadcast hash(bid + salt) — the commitment
// Phase 2 (60–80ms): solvers reveal the full bid
// A bid revealed without a matching prior commitment is rejected.
// A solver who committed but didn't reveal is penalised (null bid).
//
// This means a solver watching other bids cannot snipe at 79ms —
// they committed at t=0 and can only reveal what they committed to.
import { ethers } from 'ethers'

export const COMMIT_WINDOW_MS  = 60   // commit phase duration
export const REVEAL_WINDOW_MS  = 20   // reveal phase duration (total budget = 80ms)

/**
 * Generate a commitment for a bid.
 * commitment = keccak256(abi.encode(intentId, outputAmount, routeHash, salt))
 * salt is a random 32-byte value — prevents rainbow table attacks on commitments.
 */
export function createCommitment(bid) {
  const salt = ethers.randomBytes(32)

  const commitment = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'uint256', 'bytes32', 'bytes32'],
      [
        bid.intentId,
        bid.outputAmount,
        ethers.keccak256(
          bid.route instanceof Uint8Array ? bid.route : ethers.getBytes(bid.route)
        ),
        salt,
      ]
    )
  )

  return { commitment, salt }
}

/**
 * Verify a revealed bid matches its commitment.
 */
export function verifyCommitment(bid, commitment, salt) {
  const recomputed = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'uint256', 'bytes32', 'bytes32'],
      [
        bid.intentId,
        bid.outputAmount,
        ethers.keccak256(
          bid.route instanceof Uint8Array ? bid.route : ethers.getBytes(bid.route)
        ),
        salt,
      ]
    )
  )
  return recomputed === commitment
}

/**
 * CommitRevealAuction — drop-in replacement for _raceWithDeadline in auction.js
 *
 * Phase 1: open RFQ streams, collect commitments (hash only) within COMMIT_WINDOW_MS
 * Phase 2: request reveals from committed solvers within REVEAL_WINDOW_MS
 * Result:  only bids with valid commitment→reveal pairs are accepted
 *
 * Protocol over the /defi/rfq/1.0.0 stream:
 *   Coordinator writes intent → solver writes commitment
 *   Coordinator writes 'REVEAL' signal → solver writes { bid, salt }
 */
export class CommitRevealAuction {
  constructor(node, intent, solverPeers) {
    this.node        = node
    this.intent      = intent
    this.peers       = solverPeers
    this.commitments = new Map()  // peerId → commitment
    this.reveals     = new Map()  // peerId → { bid, salt }
  }

  /**
   * Run the two-phase commit-reveal auction.
   * @returns {Array} Array of revealed bids (empty if none). Caller selects winner.
   */
  async run() {
    const t0 = Date.now()

    // Phase 1: collect commitments
    await this._collectCommitments()
    const phase1Elapsed = Date.now() - t0
    console.log(`[commit] phase 1 done — ${this.commitments.size} commitments in ${phase1Elapsed}ms`)

    // Phase 2: collect reveals from committed solvers only
    await this._collectReveals()
    const phase2Elapsed = Date.now() - t0
    console.log(`[commit] phase 2 done — ${this.reveals.size} reveals in ${phase2Elapsed}ms`)

    // Return all revealed bids for caller to select winner
    return this._getRevealedBids()
  }

  async _collectCommitments() {
    const commitPromises = this.peers.map(async (peerId) => {
      try {
        const stream = await this.node.dialProtocol(peerId, '/defi/rfq/1.0.0', {
          signal: AbortSignal.timeout(COMMIT_WINDOW_MS),
        })

        // Send intent, receive commitment hash
        const { encodeIntent, decodeBid } = await import('../sdk/intent-codec.js')
        const { writeFramed, readFramed }  = await import('./rfq-internal.js')

        const intentBytes = await encodeIntent(this.intent)
        await writeFramed(stream, intentBytes)

        // Solver responds with 32-byte commitment hash
        const commitBytes = await readFramed(stream.source)
        if (commitBytes.length !== 32) throw new Error('Invalid commitment size')

        this.commitments.set(peerId.toString(), {
          commitment: ethers.hexlify(commitBytes),
          stream,       // keep stream open for reveal phase
        })
      } catch (err) {
        console.warn(`[commit] no commitment from ${peerId.toString().slice(0,12)}: ${err.message}`)
      }
    })

    await Promise.race([
      Promise.allSettled(commitPromises),
      new Promise(r => setTimeout(r, COMMIT_WINDOW_MS)),
    ])
  }

  async _collectReveals() {
    const revealPromises = [...this.commitments.entries()].map(
      async ([peerIdStr, { commitment, stream }]) => {
        try {
          const { readFramed, writeFramed } = await import('./rfq-internal.js')
          const { decodeBid }               = await import('../sdk/intent-codec.js')

          // Signal reveal phase
          await writeFramed(stream, new TextEncoder().encode('REVEAL'))

          // Receive { bid protobuf (N bytes) + salt (32 bytes) }
          // Frame layout: [4-byte bid length][bid bytes][32-byte salt]
          const revealBytes = await readFramed(stream.source)
          const bidLength   = new DataView(revealBytes.buffer).getUint32(0, false)
          const bidBytes    = revealBytes.slice(4, 4 + bidLength)
          const salt        = ethers.hexlify(revealBytes.slice(4 + bidLength))

          const bid = await decodeBid(bidBytes)

          // Verify commitment matches reveal
          if (!verifyCommitment(bid, commitment, salt)) {
            console.warn(`[commit] commitment mismatch from ${peerIdStr.slice(0,12)} — discarded`)
            return
          }

          this.reveals.set(peerIdStr, bid)
          await stream.close()

        } catch (err) {
          console.warn(`[commit] no reveal from ${peerIdStr.slice(0,12)}: ${err.message}`)
        }
      }
    )

    await Promise.race([
      Promise.allSettled(revealPromises),
      new Promise(r => setTimeout(r, REVEAL_WINDOW_MS)),
    ])
  }

  _getRevealedBids() {
    // Return all revealed bids; caller filters by minOutputAmount and selects winner
    return [...this.reveals.values()]
  }
}