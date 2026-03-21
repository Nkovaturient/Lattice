// Track 2.1 / 3.1 — Protobuf encode / decode for gossip wire + RFQ stream
import { ethers } from 'ethers'
import protobuf from 'protobufjs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

// ── Byte conversion helpers ───────────────────────────────────────────────────
export const hexToBytes     = hex => ethers.getBytes(hex)
export const bytesToHex     = b   => ethers.hexlify(b)
export const uint256ToBytes = val => ethers.toBeArray(BigInt(val.toString()), 32)
export const bytesToUint256 = b   => BigInt(ethers.hexlify(b)).toString()

// ── Proto loader — single root load, both types cached ───────────────────────
const __dir    = dirname(fileURLToPath(import.meta.url))
const PROTO_PATH = join(__dir, '../proto/intent.proto')

let _root      = null
let _IntentType = null
let _BidType    = null

async function getRoot() {
  if (_root) return _root
  _root       = await protobuf.load(PROTO_PATH)
  _IntentType = _root.lookupType('defi.Intent')
  _BidType    = _root.lookupType('defi.Bid')
  return _root
}

async function getIntentType() { await getRoot(); return _IntentType }
async function getBidType()    { await getRoot(); return _BidType    }

// ── Intent: JS object → proto msg shape ──────────────────────────────────────
function intentToProto(intent) {
  return {
    intentId:        hexToBytes(intent.intentId),
    user:            hexToBytes(intent.user),
    nonce:           Number(intent.nonce),
    inputToken:      hexToBytes(intent.inputToken),
    outputToken:     hexToBytes(intent.outputToken),
    inputAmount:     uint256ToBytes(intent.inputAmount),
    minOutputAmount: uint256ToBytes(intent.minOutputAmount),
    recipient:       hexToBytes(intent.recipient),
    deadline:        Number(intent.deadline),
    topicTier:       Number(intent.topicTier),
    preferredSolver: hexToBytes(intent.preferredSolver),
    signature:       hexToBytes(intent.signature),
  }
}

// ── Intent: proto msg → JS object ────────────────────────────────────────────
function intentFromProto(msg) {
  return {
    intentId:        bytesToHex(msg.intentId),
    user:            bytesToHex(msg.user),
    nonce:           msg.nonce.toString(),
    inputToken:      bytesToHex(msg.inputToken),
    outputToken:     bytesToHex(msg.outputToken),
    inputAmount:     bytesToUint256(msg.inputAmount),
    minOutputAmount: bytesToUint256(msg.minOutputAmount),
    recipient:       bytesToHex(msg.recipient),
    deadline:        Number(msg.deadline),
    topicTier:       msg.topicTier,
    preferredSolver: bytesToHex(msg.preferredSolver),
    signature:       bytesToHex(msg.signature),
  }
}

// ── Bid: JS object → proto msg shape ─────────────────────────────────────────
function bidToProto(bid) {
  return {
    intentId:     hexToBytes(bid.intentId),           // 32 bytes
    solver:       hexToBytes(bid.solver),              // 20 bytes
    outputAmount: uint256ToBytes(bid.outputAmount),    // 32 bytes big-endian
    route:        bid.route instanceof Uint8Array
                    ? bid.route
                    : hexToBytes(bid.route),           // ABI-encoded path bytes
    deadline:     Number(bid.deadline),
    signature:    hexToBytes(bid.signature),           // 65 bytes
  }
}

// ── Bid: proto msg → JS object ────────────────────────────────────────────────
function bidFromProto(msg) {
  return {
    intentId:     bytesToHex(msg.intentId),
    solver:       bytesToHex(msg.solver),
    outputAmount: bytesToUint256(msg.outputAmount),
    route:        msg.route,                           // keep as Uint8Array — settlement uses it raw
    deadline:     Number(msg.deadline),
    signature:    bytesToHex(msg.signature),
  }
}

// ── Public API — Intent ───────────────────────────────────────────────────────

/** Encode a signed intent → Uint8Array for GossipSub wire. ~0.1ms */
export async function encodeIntent(intent) {
  const T   = await getIntentType()
  const msg = T.create(intentToProto(intent))
  const err = T.verify(msg)
  if (err) throw new Error(`Intent proto verify failed: ${err}`)
  return T.encode(msg).finish()
}

/** Decode GossipSub wire bytes → JS intent object. Throws on malformed input. */
export async function decodeIntent(bytes) {
  const T = await getIntentType()
  return intentFromProto(T.decode(bytes))
}

/**
 * Sync decode — only safe after initCodec() has resolved.
 * Used in intentMessageId() — runs on every gossip message, cannot be async.
 */
export function decodeIntentSync(bytes) {
  if (!_IntentType) throw new Error('Codec not initialised — call initCodec() at startup')
  return intentFromProto(_IntentType.decode(bytes))
}

// ── Public API — Bid ──────────────────────────────────────────────────────────

/** Encode a signed bid → Uint8Array for RFQ stream wire. */
export async function encodeBid(bid) {
  const T   = await getBidType()
  const msg = T.create(bidToProto(bid))
  const err = T.verify(msg)
  if (err) throw new Error(`Bid proto verify failed: ${err}`)
  return T.encode(msg).finish()
}

/** Decode RFQ stream bytes → JS bid object. Throws on malformed input. */
export async function decodeBid(bytes) {
  const T = await getBidType()
  return bidFromProto(T.decode(bytes))
}

// ── Startup ───────────────────────────────────────────────────────────────────

/**
 * Pre-warm the proto loader at node startup.
 * Must be awaited before any gossip messages or RFQ streams arrive.
 */
export async function initCodec() {
  await getRoot()
}