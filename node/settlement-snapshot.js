import { ethers } from 'ethers'

function bytes32Hex(x) {
  if (typeof x === 'string' && x.startsWith('0x') && x.length === 66)
    return x
  return ethers.hexlify(x)
}

function sigHex(sig) {
  if (typeof sig === 'string' && sig.startsWith('0x'))
    return sig
  if (sig instanceof Uint8Array)
    return ethers.hexlify(sig)
  return ethers.hexlify(sig)
}

/** EIP-712 + wire fields suitable for INTENT_JSON.partial or pair JSON. */
export function serializeIntentRecord(intent) {
  const pref = intent.preferredSolver ?? ethers.ZeroAddress
  return {
    user: ethers.getAddress(intent.user),
    nonce: String(intent.nonce),
    inputToken: ethers.getAddress(intent.inputToken),
    outputToken: ethers.getAddress(intent.outputToken),
    inputAmount: String(intent.inputAmount),
    minOutputAmount: String(intent.minOutputAmount),
    recipient: ethers.getAddress(intent.recipient),
    deadline: Number(intent.deadline),
    topicTier: Number(intent.topicTier),
    preferredSolver: ethers.getAddress(pref),
    intentId: bytes32Hex(intent.intentId),
    signature: sigHex(intent.signature),
  }
}

export function serializeBidRecord(bid, intent) {
  const routeRaw = bid.route ?? bid.encodedRoute
  const routeHex =
    routeRaw instanceof Uint8Array
      ? ethers.hexlify(routeRaw)
      : typeof routeRaw === 'string' && routeRaw.startsWith('0x')
        ? routeRaw
        : ethers.hexlify(routeRaw ?? new Uint8Array(0))

  return {
    intentId: bytes32Hex(bid.intentId),
    solver: ethers.getAddress(bid.solver),
    outputAmount: String(bid.outputAmount),
    route: routeHex,
    deadline: Number(bid.deadline ?? intent.deadline),
    signature: sigHex(bid.signature),
  }
}

/**
 * Canonical `{ intent, bid }` for INTENT_JSON, settle-debug, emit-settle-calldata,
 * and `jq -c` → scripts/settle.js.
 */
export function serializeSettlementSnapshot(intent, bid) {
  return {
    intent: serializeIntentRecord(intent),
    bid:    serializeBidRecord(bid, intent),
  }
}
