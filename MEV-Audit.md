# Lattice — MEV Resistance Audit
## Track 5.2 — Timing Attacks, Collusion Vectors, Commit-Reveal Analysis

---

## Attack vectors and mitigations

### 1. Gossip timing fingerprinting — HIGH — MITIGATED

**Attack:** A malicious solver measures intent arrival time across mesh peers.
By correlating timestamps across multiple vantage points, they triangulate
the originating user node — leaking identity before the auction opens.

**Root cause:** GossipSub with D=4 has deterministic propagation paths.
An adversary with 2+ mesh peers can perform multilateration.

**Mitigation (implemented):**
Random 0–15ms jitter in `validators.js` before forwarding any valid intent.
Applied after validation passes — invalid messages are still rejected instantly.

```javascript
// src/p2p/validators.js
const JITTER_MAX_MS = 15
async function propagationJitter() {
  return new Promise(resolve => setTimeout(resolve, Math.random() * JITTER_MAX_MS))
}
// Applied as final step in _validate() before returning Accept
await propagationJitter()
```

**Residual risk:** Adversary with 4+ mesh peers can average out jitter.
Full mitigation requires onion-routing or mixnet — out of scope for v1.

---

### 2. Auction sniping via late bid injection — HIGH — MITIGATED

**Attack:** A solver with network advantage waits until t=79ms, observes
all competing bids via a colluding peer, then undercuts the current winner
by 1 wei. The `_arrivedAt` tie-break is meaningless against a fast attacker.

**Root cause:** Open auction — bids are visible to all participants.

**Mitigation (implemented):**
Two-phase commit-reveal in `src/p2p/commitment.js`:

```
t=0ms   → coordinator sends intent to all solvers
t=0–60ms → COMMIT phase: solvers send hash(bid + salt)
t=60–80ms → REVEAL phase: solvers send full bid + salt
Winner:   highest outputAmount with valid commitment→reveal match
```

A solver who waits to observe others' bids cannot change their commitment.
A solver who commits but doesn't reveal gets null (excluded from auction).

**Trade-off:** Adds protocol complexity. Two round-trips per auction.
Latency impact: minimal — commit is just a 32-byte hash, fast to send/verify.

---

### 3. Settlement front-running — MEDIUM — ALREADY MITIGATED

**Attack:** Searcher copies winning solver's settlement calldata from mempool,
submits same tx with higher gas tip to front-run the solver's fee.

**Why it fails:** `IntentSettlement.sol` enforces:
```solidity
require(bid.solver == msg.sender, "Bid solver mismatch");
```
The settlement contract only accepts calls from the solver named in the bid.
Anyone else submitting the same calldata will revert. No additional mitigation needed.

**Residual risk on Arbitrum:** Arbitrum's sequencer is centralized —
Offchain Labs could theoretically reorder txs. Mitigated by Arbitrum's
fair sequencing commitments and the lack of financial incentive for the sequencer
(they don't receive MEV from tx reordering the way Ethereum validators do).

---

### 4. Bid withholding cartel — HIGH — PARTIALLY MITIGATED

**Attack:** N colluding tier-1 solvers all return `null` for target intents,
forcing users toward a captive solver. Currently undetectable off-chain.

**Mitigation (partial, implemented in SolverRegistry.sol):**
Fill history tracked on-chain via `recordFill()`. Tier-1 requires 10 fills minimum.
A solver who withholds fills cannot maintain tier-1 access indefinitely.

**Full mitigation (v2 scope):**
On-chain fill rate monitoring. If a registered solver's fill rate drops below
a threshold over a rolling window, automatic demotion to tier-0.
Requires a separate keeper contract to compute and enforce — added to v2 backlog.

---

### 5. Tier-1 subnet information leak — MEDIUM — OPEN

**Attack:** A registered tier-1 solver forwards intent data out-of-band to
an unregistered solver. The unregistered solver trades ahead of settlement.
The p2p layer cannot detect out-of-band communication.

**Current state:** No mitigation in v1. This is the hardest attack to prevent
without fundamentally changing the architecture.

**Mitigation path (v2):**
Intent encryption per-solver: each intent is encrypted to the solver's libp2p
public key before propagation. Only the addressed solver can decrypt and compute.
Requires:
- Public key registry (solver registers pubkey with PeerID on-chain)
- ElGamal or ECIES encryption of intent payload per recipient
- Increases intent size from 289B to ~289 + N*65B for N solvers

Trade-off: significant complexity + latency increase. Deferred to v2.

---

### 6. Fake solver Sybil admission — MEDIUM — MITIGATED

**Attack:** Attacker registers many solver nodes at minimum stake to flood the
tier-1 subnet with observers who never fill intents.

**Mitigation (implemented):**
Progressive stake tiers in updated `SolverRegistry.sol`:
- Tier 0: 0.05 ETH stake
- Tier 1: 0.5 ETH stake + 10 successful fills

10 fills × average solver fee (~$0.50 on Arbitrum) = ~$5 economic cost to reach tier-1.
Plus 0.5 ETH = ~$1,500 at current prices. Sybil attack requires $1,500+ per fake node.

---

### 7. Overpromise / slash griefing — HIGH (was exploitable) — MITIGATED

**Attack (historical):** A solver bids an inflated `outputAmount`. After settlement,
a caller could pass an **arbitrary** `actualOutput` into `slashForOverpromise` and
slash any solver whose bid signature was still valid — no on-chain link to the real swap output.

**Mitigation (implemented in `IntentSettlement.sol`):**

- On successful settlement, the contract stores **`settlementActualOutput[intentId]`** (the swap return value) before paying the recipient and solver.
- **`slashForOverpromise(bid, bidSig)`** — signature only; **no** caller-supplied output. The contract requires the intent to be settled and **`recorded < bid.outputAmount`** using the **stored** output. Calls **`slashOverpromise(solver)`** on the registry: if the solver still has slashable stake, behavior matches a normal stake slash; if they were already auto-deregistered (or have no stake), **`slashes` still increments** and **`SolverSlashed` emits `amount == 0`** so reputation accounting completes. **`No solver history`** reverts unknown addresses.
- **`settle()`** follows **CEI** (`settled` + `incrementNonce` before the first external call), **`nonReentrant`**, and **SafeERC20** for router approval and payouts — closing reentrancy / double-settlement and odd ERC20 behavior.
- **`ECDSA.tryRecover`** (OpenZeppelin) replaces raw `ecrecover` assembly so signatures are **non-malleable** (EIP-2) and **`slashForOverpromise`** cannot be armed with an alternate `(r, s', v')` of the same key.

**Related (tier / auction semantics):** The signed intent fields **`preferredSolver`** and **`topicTier`** are enforced in `settle()` so they match user expectations from EIP-712.

**Residual:** Failed settlements (e.g. swap reverts) still do not call `recordFill()` — repeated failures slow tier progression. Slashed wei is tracked as **`slashProceedsBalance`** and can be withdrawn via **`sweepSlashedFunds()`** by the immutable **`treasury`** address set at deploy.

---

## Commit-reveal latency analysis

```
Phase 1 — commit (0–60ms):
  solver compute + sign bid:         ~2ms   (from benchmark)
  hash(bid + salt):                  ~0.1ms
  send 32-byte commitment:           ~1ms   (network)
  ─────────────────────────────────
  total solver commit time:          ~3ms
  remaining for network jitter:      ~57ms  ✓

Phase 2 — reveal (60–80ms):
  receive REVEAL signal:             ~1ms
  send bid + salt (~300B):           ~1ms
  coordinator verify commitment:     ~0.1ms
  bid selection:                     ~0.1ms
  ─────────────────────────────────
  total reveal time:                 ~2ms
  remaining budget:                  ~18ms  ✓
```

The commit-reveal scheme fits inside 80ms with room to spare.

---

## What's NOT protected (v1 scope)

| Vector | Status | Path |
|---|---|---|
| Out-of-band intent forwarding | Open | v2: per-solver encryption |
| Sequencer-level reordering (Arbitrum) | Low risk | Trust Offchain Labs commitments |
| Fill rate cartel at scale | Partial | v2: on-chain fill rate keeper |
| Long-range timing correlation | Partial | Future: mixnet integration |

---

## Files changed in Track 5.2

| File | Change |
|---|---|
| `libp2p/validators.js` | Added propagation jitter (0–15ms) |
| `libp2p/commitment.js` | New: two-phase commit-reveal auction |
| `contracts/SolverRegistry.sol` | Progressive stake tiers + fill history; `treasury` + `slashProceedsBalance` + `sweepSlashedFunds()`; `slash` + `slashOverpromise` (accounting-only overpromise when deregistered); `deregister` uses `call{value:}`; slash auto-deregister refunds residual stake |
| `contracts/IntentSettlement.sol` | `recordFill()` on success; CEI + `nonReentrant` + SafeERC20; `settlementActualOutput`; `slashForOverpromise(bid, bidSig)`; `preferredSolver` / `topicTier`; `bid.deadline <= intent.deadline`; ERC20-only tokens |
| `contracts/foundry.toml` | OpenZeppelin remapping; `via_ir` for `settle` compilation |
| `lib/openzeppelin-contracts` | Dependency: SafeERC20, ReentrancyGuard |