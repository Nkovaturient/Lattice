// Track 3.1 — Solver bid builder (stub → real)
// Builds, EIP-712 signs, and encodes a bid from a computed solution.
import { ethers } from 'ethers'
import { DOMAIN, BID_TYPE } from './domain.js'
import { encodeBid } from './intent-codec.js'

/**
 * Build a signed, protobuf-encoded bid ready to write into a /defi/rfq/1.0.0 stream.
 *
 * Called inside the solver's computeSolution pipeline after pathfinding completes.
 * The encoded result is passed back to rfq-protocol.js → writeFramed().
 *
 * @param {ethers.Signer} solverSigner  — solver's EVM wallet
 * @param {object}        intent        — decoded intent from the RFQ stream
 * @param {object}        solution      — { outputAmount: string, encodedRoute: Uint8Array }
 * @returns {Promise<{ bidObj, encodedBid: Uint8Array }>}
 */
export async function buildBid(solverSigner, intent, solution) {
  const solverAddress = await solverSigner.getAddress()

  // Typed data to sign — matches BID_TYPEHASH in IntentTypes.sol exactly
  const bidData = {
    intentId:     intent.intentId,
    solver:       solverAddress,
    outputAmount: solution.outputAmount.toString(),
    route:        solution.encodedRoute instanceof Uint8Array
                    ? ethers.hexlify(solution.encodedRoute)
                    : solution.encodedRoute,
    deadline:     intent.deadline,
  }

  // EIP-712 sign — verified by IntentSettlement.sol on-chain
  const signature = await solverSigner.signTypedData(DOMAIN, BID_TYPE, bidData)

  const bidObj = { ...bidData, signature }

  // Encode to protobuf bytes — ready for writeFramed() in rfq-protocol.js
  const encodedBid = await encodeBid({
    ...bidObj,
    route: solution.encodedRoute,  // keep as Uint8Array for proto encoding
  })

  return { bidObj, encodedBid }
}

/**
 * Verify a received bid's EIP-712 signature.
 * Called by the auction coordinator before accepting a bid into the auction.
 * Returns the recovered solver address, or throws on bad sig.
 */
export function verifyBid(bid) {
  const { signature, ...bidData } = bid
  const routeHex = bid.route instanceof Uint8Array
    ? ethers.hexlify(bid.route)
    : bid.route

  const recovered = ethers.verifyTypedData(
    DOMAIN,
    BID_TYPE,
    { ...bidData, route: routeHex },
    signature
  )
  return recovered  // caller checks recovered === expected solver address
}