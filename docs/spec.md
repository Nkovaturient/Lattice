# Phase 2 — Concrete Coding Spec
## Intent-Based DeFi · js-libp2p · EVM Settlement

> Status: LOCKED.
> Covers: Track 2.1 (Intent Schema), Track 2.2 (GossipSub Topology), Track 2.3 (Validation)

---

## Locked Design Decisions

| # | Decision | Choice | Reason |
|---|---|---|---|
| D1 | Partial fills | No — exact fill only in v1 | Complexity not justified without volume data |
| D2 | Auction window | Protocol-fixed at 80ms — removed from intent struct | Users cannot reason about latency; solvers need fixed compute budget |
| D3 | Solver node type | Server nodes only (always-on, WebSocket) | Browser solvers cannot hit sub-100ms reliably |
| D4 | Topic tiers | 2 tiers: `public` + `tier1` | Single topic leaks; 3 tiers premature before solver count justifies it |
| D5 | Registry check | In-memory cache, 60s TTL, event-invalidated | Fresh RPC (50–200ms) kills auction budget |

---

## Track 2.1 — Intent Schema

### EIP-712 Domain (constant, never changes per deployment)

```javascript
const DOMAIN = {
  name:              'IntentDeFi',
  version:           '1',
  chainId:           1,                              // mainnet; 11155111 for Sepolia
  verifyingContract: SETTLEMENT_CONTRACT_ADDRESS,
}
```

### Intent Struct (Solidity + JS mirror)

**Solidity:**
```solidity
struct Intent {
    // Identity
    address user;               // signer / payer
    uint256 nonce;              // per-user, incremented on settlement

    // Swap specification
    address inputToken;         // address(0) = native ETH
    address outputToken;
    uint256 inputAmount;        // exact amount in — no partial fills
    uint256 minOutputAmount;    // slippage floor — revert if output < this
    address recipient;          // output destination (may differ from user)

    // Timing
    uint64  deadline;           // unix timestamp — hard expiry on-chain

    // Routing
    uint8   topicTier;          // 0 = public, 1 = tier-1 solvers only
    address preferredSolver;    // address(0) = open auction
}
```

**EIP-712 type array (JS):**
```javascript
const INTENT_TYPE = {
  Intent: [
    { name: 'user',             type: 'address' },
    { name: 'nonce',            type: 'uint256' },
    { name: 'inputToken',       type: 'address' },
    { name: 'outputToken',      type: 'address' },
    { name: 'inputAmount',      type: 'uint256' },
    { name: 'minOutputAmount',  type: 'uint256' },
    { name: 'recipient',        type: 'address' },
    { name: 'deadline',         type: 'uint64'  },
    { name: 'topicTier',        type: 'uint8'   },
    { name: 'preferredSolver',  type: 'address' },
  ],
}
```

**Fields removed vs earlier drafts:**
- `auctionWindowMs` — removed; protocol constant (80ms), not user data
- `chainId` in struct — removed; already in EIP-712 domain, no duplication
- `routingHint` — removed for v1; add in v2 when solver routing is proven
- `allowPartialFill` — not included; exact fill only

### intentId Computation

```javascript
import { ethers } from 'ethers'

// intentId = EIP-712 hash of the intent — canonical reference everywhere
export function computeIntentId(intentData) {
  return ethers.TypedDataEncoder.hash(DOMAIN, INTENT_TYPE, intentData)
}
```

`intentId` is the GossipSub `messageId`, the settlement contract's dedup key,
and the bid's back-reference. It must be computed identically on JS and Solidity.

### buildAndSignIntent (user-facing SDK)

```javascript
export async function buildAndSignIntent(signer, params) {
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
    deadline:        Math.floor(Date.now() / 1000) + 600, // 10 min hard expiry
    topicTier:       params.topicTier ?? 0,
    preferredSolver: params.preferredSolver ?? ethers.ZeroAddress,
  }

  const signature = await signer.signTypedData(DOMAIN, INTENT_TYPE, intentData)
  const intentId  = computeIntentId(intentData)

  return { ...intentData, intentId, signature }
}
```

**Validation constraints the SDK must enforce before signing:**
- `inputAmount > 0`
- `minOutputAmount > 0` and `minOutputAmount < expectedOutputAmount` (warn if > 5% slippage)
- `inputToken !== outputToken`
- `deadline` must be at least 60 seconds from now (prevent stale intents)
- `topicTier` must be 0 or 1 — reject anything else

### Protobuf Wire Format

```proto
// proto/intent.proto
syntax = "proto3";
package defi;

message Intent {
  bytes   intent_id         = 1;   // 32 bytes — keccak256
  bytes   user              = 2;   // 20 bytes — EVM address
  uint64  nonce             = 3;
  bytes   input_token       = 4;   // 20 bytes
  bytes   output_token      = 5;   // 20 bytes
  bytes   input_amount      = 6;   // 32 bytes — uint256 big-endian
  bytes   min_output_amount = 7;   // 32 bytes — uint256 big-endian
  bytes   recipient         = 8;   // 20 bytes
  uint64  deadline          = 9;
  uint32  topic_tier        = 10;
  bytes   preferred_solver  = 11;  // 20 bytes
  bytes   signature         = 12;  // 65 bytes
}
```

**Encoding rules:**
- All EVM addresses: 20-byte hex → `Uint8Array` (strip 0x prefix)
- All uint256 values: BigInt → 32-byte big-endian `Uint8Array`
- `signature`: 65-byte `Uint8Array` (v, r, s — standard Ethereum format)
- Never encode uint256 as a protobuf `uint64` — overflow for large token amounts

```javascript
// helpers — used in both encode and decode
const hexToBytes = hex => ethers.getBytes(hex)
const uint256ToBytes = val => ethers.toBeArray(BigInt(val), 32)  // 32-byte big-endian
const bytesToHex = bytes => ethers.hexlify(bytes)
const bytesToUint256 = bytes => BigInt(ethers.hexlify(bytes)).toString()
```

### GossipSub messageIdFn

```javascript
// Use intentId directly — it's already a 32-byte keccak256
// ~0.1ms vs ~0.3ms for re-hashing the payload
export function intentMessageId(msg) {
  const intent = decodeIntent(msg.data)
  return hexToBytes(intent.intentId)
}
```

---

## Track 2.2 — GossipSub Topology

### Topic Names (locked strings — breaking change to modify)

```javascript
export const TOPICS = {
  PUBLIC: 'intents/v1/evm/1/public',    // open — any peer
  TIER1:  'intents/v1/evm/1/tier1',     // staked registered solvers only
}
// Note: chain ID (1) is baked into topic name — different deployments = different topics
// Private RFQ topic deferred to Track 3.1
```

### GossipSub Configuration

```javascript
gossipsub({
  emitSelf:          false,    // never process your own published intents
  gossipIncoming:    true,     // relay incoming gossip to mesh peers
  fallbackToFloodsub: false,   // disable — pure gossipsub mesh only
  floodPublish:      false,    // do NOT flood on publish — use mesh only

  // Mesh parameters — tuned for 10–30 solver nodes, sub-100ms propagation
  D:   4,     // target mesh degree (default 6 — lower = fewer hops)
  Dlo: 2,     // minimum mesh peers before grafting more
  Dhi: 6,     // maximum mesh peers before pruning
  Dscore: 2,  // minimum score-qualified peers in mesh

  heartbeatInterval: 500,      // ms — mesh re-evaluation (default 1000ms)
  fanoutTTL:         60_000,   // ms — how long to track fanout peers
  mcacheLength:      6,        // message cache window (heartbeat intervals)
  mcacheGossip:      3,        // number of cached message IDs to gossip

  // Validation — MUST be true for topic validators to work
  asyncValidation:   true,

  // Content-addressed dedup
  messageIdFn:       intentMessageId,

  // Score parameters — prune slow/misbehaving peers from mesh
  scoreThresholds: {
    gossipThreshold:       -10,
    publishThreshold:      -50,
    graylistThreshold:     -80,
    acceptPXThreshold:     0,
    opportunisticGraftThreshold: 1,
  },
})
```

**Mesh degree rationale:** With 15 solver nodes and D=4, any intent reaches all nodes
in at most 2 hops (~2 × 5ms = 10ms propagation). D=6 would add redundancy
but increase message duplication overhead. For a trusted solver subnet, D=4 is correct.

### Node Roles

| Role | Subscribes to | Publishes to | Transport |
|---|---|---|---|
| User dApp node | neither | PUBLIC or TIER1 | WebSocket + WebRTC |
| Public solver | PUBLIC | — | WebSocket (TCP) |
| Tier-1 solver | PUBLIC + TIER1 | — | WebSocket (TCP) |
| Bootstrap node | neither | — | WebSocket (TCP) |

User nodes publish intents, solver nodes consume them. Solvers do not publish
to GossipSub — bids travel over direct streams (Track 3.1).

---

## Track 2.3 — Validation Middleware

### Validation Pipeline (ordered — fail fast)

Every message received on any topic passes through this pipeline
before GossipSub propagates it to other peers.

```
Step 1: Decode protobuf                      ~0.1ms
Step 2: Check intentId format (32 bytes)     ~0.05ms
Step 3: Check deadline (not expired)         ~0.05ms
Step 4: Verify EIP-712 signature             ~0.5ms
Step 5: Recompute intentId, compare          ~0.5ms
Step 6: Registry cache lookup (tier1 only)   ~0.1ms  (cache hit)
Step 7: Accept                               ——————
                                    total ~  1.3ms
```

Total validation budget: 2ms. Well inside the 80ms auction window.
Reject at the earliest possible step to avoid wasted CPU.

### Implementation

```javascript
import { TopicValidatorResult } from '@libp2p/interface'
import { ethers } from 'ethers'

export function attachIntentValidators(node, registryCache) {

  // ── Public topic validator ───────────────────────────────────────────
  node.services.pubsub.topicValidators.set(
    TOPICS.PUBLIC,
    async (peerId, msg) => validateIntent(msg, { tierCheck: false }, registryCache)
  )

  // ── Tier-1 topic validator ───────────────────────────────────────────
  node.services.pubsub.topicValidators.set(
    TOPICS.TIER1,
    async (peerId, msg) => validateIntent(msg, { tierCheck: true, peerId }, registryCache)
  )
}

async function validateIntent(msg, options, registryCache) {
  // Step 1: decode
  let intent
  try {
    intent = decodeIntent(msg.data)
  } catch {
    return TopicValidatorResult.Reject   // malformed protobuf
  }

  // Step 2: intentId sanity
  if (!intent.intentId || hexToBytes(intent.intentId).length !== 32) {
    return TopicValidatorResult.Reject
  }

  // Step 3: deadline
  const nowSec = Math.floor(Date.now() / 1000)
  if (nowSec >= intent.deadline) {
    return TopicValidatorResult.Reject   // expired — don't propagate stale intents
  }

  // Step 4: EIP-712 signature
  let recoveredAddress
  try {
    recoveredAddress = ethers.verifyTypedData(
      DOMAIN,
      INTENT_TYPE,
      intentWithoutSig(intent),   // exclude 'signature' field from verification data
      intent.signature
    )
  } catch {
    return TopicValidatorResult.Reject   // malformed signature
  }

  if (recoveredAddress.toLowerCase() !== intent.user.toLowerCase()) {
    return TopicValidatorResult.Reject   // sig doesn't match user address
  }

  // Step 5: intentId integrity — recompute and compare
  const recomputed = computeIntentId(intentWithoutSig(intent))
  if (recomputed !== intent.intentId) {
    return TopicValidatorResult.Reject   // intentId was tampered
  }

  // Step 6: tier-1 registry check (only on tier-1 topic)
  if (options.tierCheck) {
    const isRegistered = await registryCache.isSolverRegistered(options.peerId)
    if (!isRegistered) {
      return TopicValidatorResult.Reject // peer not in solver registry
    }
  }

  return TopicValidatorResult.Accept
}
```

### Registry Cache

```javascript
export class SolverRegistryCache {
  #cache  = new Map()   // peerId string → { registered: bool, cachedAt: ms }
  #ttlMs  = 60_000      // 60 seconds

  constructor(registryContract, provider) {
    this.registry = registryContract
    this.provider = provider
    this.#startEventListeners()
  }

  async isSolverRegistered(peerId) {
    const entry = this.#cache.get(peerId.toString())
    const now   = Date.now()

    // Cache hit and fresh
    if (entry && (now - entry.cachedAt) < this.#ttlMs) {
      return entry.registered
    }

    // Cache miss or stale — fetch from chain
    const evmAddress = await this.#peerIdToEvmAddress(peerId)
    if (!evmAddress) {
      this.#cache.set(peerId.toString(), { registered: false, cachedAt: now })
      return false
    }

    const registered = await this.registry.isRegistered(evmAddress)
    this.#cache.set(peerId.toString(), { registered, cachedAt: now })
    return registered
  }

  // Invalidate immediately on chain events — don't wait for TTL
  #startEventListeners() {
    this.registry.on('SolverRegistered', (evmAddress) => {
      this.#invalidateByEvmAddress(evmAddress)
    })
    this.registry.on('SolverSlashed', (evmAddress) => {
      this.#invalidateByEvmAddress(evmAddress)
    })
    this.registry.on('SolverDeregistered', (evmAddress) => {
      this.#invalidateByEvmAddress(evmAddress)
    })
  }

  #invalidateByEvmAddress(evmAddress) {
    for (const [peerId, entry] of this.#cache) {
      if (entry.evmAddress?.toLowerCase() === evmAddress.toLowerCase()) {
        this.#cache.delete(peerId)
      }
    }
  }

  async #peerIdToEvmAddress(peerId) {
    // Looks up the on-chain PeerID → address binding
    // registered via SolverRegistry.register(peerId, signature)
    return this.registry.peerIdToAddress(peerId.toString())
  }
}
```

---

## File Deliverables

```
src/
├── proto/
│   └── intent.proto                   ← wire schema (protobuf)
│
├── sdk/
│   ├── domain.js                      ← DOMAIN + INTENT_TYPE constants
│   ├── intent-builder.js              ← buildAndSignIntent()
│   ├── intent-codec.js                ← encodeIntent() / decodeIntent()
│   ├── intent-id.js                   ← computeIntentId() / intentMessageId()
│   └── bid-builder.js                 ← buildBid() (Track 3.1 dependency)
│
├── p2p/
│   ├── topics.js                      ← TOPICS constants
│   ├── gossip-config.js               ← gossipsub() config object
│   ├── validators.js                  ← attachIntentValidators()
│   └── registry-cache.js             ← SolverRegistryCache class
│
└── contracts/
    └── IntentTypes.sol                ← EIP-712 type definitions (library)
```

---

## Protocol Constants (hardcoded — not configurable)

| Constant | Value | Reason |
|---|---|---|
| `AUCTION_WINDOW_MS` | `80` | Fixed budget — solvers optimize to this |
| `MAX_DEADLINE_OFFSET_SEC` | `600` | 10 min max intent lifetime |
| `MIN_DEADLINE_OFFSET_SEC` | `60` | Prevent intents expiring before settlement tx lands |
| `REGISTRY_CACHE_TTL_MS` | `60_000` | 60s — 5x mainnet block time |
| `GOSSIP_MESH_D` | `4` | Tuned for 10–30 solver nodes |
| `GOSSIP_HEARTBEAT_MS` | `500` | Half default — faster peer quality evaluation |
| `SOLVER_RFQ_TIMEOUT_MS` | `60` | Per-solver timeout leaving 20ms for resolution |
| `MIN_INPUT_AMOUNT` | `1` (wei) | Reject dust intents |

---

## What This Spec Does NOT Cover (deferred)

- Private RFQ topic (`intents/v1/evm/1/rfq/{address}`) → Track 3.1
- Solver bid schema → Track 3.1
- DEX route encoding inside bid → Track 3.3
- IntentSettlement.sol → Track 4.1
- Solver stake / slash logic → Track 4.2