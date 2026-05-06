# Lattice — Production Roadmap

> *"The mesh is the protocol."*
>
> This document records the engineering path from a working MVP to a production-grade,
> chain-agnostic, MEV-resistant intent coordination layer. Each phase has a clear
> goal, a precise technical scope, success criteria, and honest notes on
> what could go wrong. Nothing here is aspirational padding — every item earns
> its place by addressing a concrete failure mode or capability gap.

---

## Current State (post-MVP baseline)

The following is working end-to-end on Arbitrum Sepolia as of the baseline commit:

**P2P coordination layer** — GossipSub mesh forms correctly between user and solver nodes. Intent propagates from `run-user.js` to `run-solver.js` via the `intents/v1/evm/1/public` topic. The two-phase commit-reveal auction in `commitment.js` is implemented and wired into `auction.js`. EIP-712 intent and bid signatures are produced and verified correctly off-chain.

**On-chain trust layer** — `SolverRegistry.sol` registers solvers by PeerID and EVM address with stake-based tiering. `IntentSettlement.sol` validates both EIP-712 signatures on-chain and routes execution through Uniswap v3 `SwapRouter.exactInput`.

**Current blocker** — `settle()` reverts with no revert data. Root cause: the Uniswap v3 `uniswapV3SwapCallback` fires `require(amount0Delta > 0 || amount1Delta > 0)` when the pool has zero active liquidity in its tick range. This is a testnet infra problem, not a protocol problem. The entire coordination layer (mesh, signatures, nonce, registration) is correct.

**Nonce strategy (resolved)** — User intent nonces are physically stored in `SolverRegistry` (v1 implementation detail). `IntentSettlement.nonces(user)` now provides a passthrough view that all JS callers must use. This aligns EIP-712 ergonomics: clients always read from the `verifyingContract` address. In v2, storage will move natively to `IntentSettlement` — clients require no change at that point.

---

## Five concrete steps in order:

1. Real Uniswap execution on Arbitrum mainnet (or anvil fork) — same contract, real liquidity
2. Bid heterogeneity (SOLVER_MARGIN_BPS + QuoterV2, gated by benchmark numbers)
3. Multi-wallet, multi-region solvers — turn the demo into a real distributed mesh
4. Slashing + reputation loop (ROADMAP 4.2)

## Phase 5 — Foundation Hardening *(current sprint)*

**Goal:** Make the full end-to-end loop demonstrable and testable. Every claim about the protocol's correctness should be checkable by running a script, not by reading code.

### 5.1 — Deploy MockIntentSettlement and unblock Sepolia settlement

`MockIntentSettlement.sol` (see `/contracts/MockIntentSettlement.sol`) preserves every validation check from the production contract — signature recovery, nonce guard, deadline, tier, bid floor — but replaces the `SwapRouter.exactInput` call with a direct `safeTransferFrom(user, recipient, inputAmount)`. This proves the coordination layer on-chain without a dependency on testnet AMM liquidity.

**Deployment steps:**

```bash
# 1. Install deps (if using Foundry)
forge install OpenZeppelin/openzeppelin-contracts

# 2. Deploy
forge create contracts/MockIntentSettlement.sol:MockIntentSettlement \
  --constructor-args $SOLVER_REGISTRY_ADDRESS \
  --rpc-url $ARB_SEPOLIA_RPC \
  --private-key $PRIVATE_KEY \
  --verify

# 3. Update .env
INTENT_SETTLEMENT_ADDRESS=<new_mock_address>
SETTLEMENT_CONTRACT_ADDRESS=<new_mock_address>

# 4. Re-sign is required — verifyingContract in EIP-712 domain has changed.
#    Kill run-solver and run-user, restart with new env, run fresh intent.
```

**Nonce fix (done)** — `IntentSettlement.nonces(address user)` passthrough added. `settlement-preflight.js`, `run-user.js`, and `intent-builder.js` all read through the settlement address. v1 storage remains on `SolverRegistry`; clients are decoupled from that detail.

**Success criteria:** `[settle] IntentSettled intentId=… solver=…` appears in the solver terminal and is visible on Arbiscan Sepolia. The `MockExecutionSkipped` event confirms the route was received but not executed.

### 5.2 — Foundry test suite for settlement contracts

A working on-chain integration is only trustworthy if the edge cases are tested. The test suite should cover: valid settle (happy path), replay prevention (settled twice), expired intent, expired bid, nonce mismatch, bad intent signature, bad bid signature, bid intentId mismatch, bid below floor, solver not registered, tier mismatch, preferred solver bypass. Each test should use named custom errors for precise assertion.

Create `test/MockIntentSettlement.t.sol`:

```solidity
// Pattern for each test:
function test_settle_replayPrevention() public {
    // settle once — should succeed
    vm.prank(solver);
    mock.settle(intent, intentSig, bid, bidSig);

    // settle again with same intentId — should revert
    vm.prank(solver);
    vm.expectRevert(abi.encodeWithSelector(
        MockIntentSettlement.IntentAlreadySettled.selector, intentId
    ));
    mock.settle(intent, intentSig, bid, bidSig);
}
```

Run with `forge test --match-contract MockIntentSettlement -vvv`.

### 5.3 — Latency benchmarking harness

The 80ms auction window is a protocol constant, but right now it is only verified by reading log timestamps manually. A proper harness should instrument every phase and print a structured report.

Create `scripts/bench-latency.js`:

```js
// Phases to measure:
// T0: intent built + signed
// T1: intent received by solver (gossip message event)
// T2: compute complete (solution returned)
// T3: auction closed (winner selected)
// T4: staticCall complete
// T5: tx submitted
// T6: tx confirmed (block)

// Output: p50, p95, p99 across N runs, per phase and end-to-end
```

Run with `BENCH_RUNS=20 node scripts/bench-latency.js`. This gives you hard numbers for any pitch or documentation: "gossip propagation: 11ms p50, 17ms p99 on loopback; 23ms p50, 41ms p99 across two VPS nodes in same region."

### 5.4 — Multi-node demo harness

The most compelling demonstration runs three solver nodes competing. Create `scripts/run-demo.sh` that:

```bash
# Starts bootstrap node, three solver nodes on ports 9000/9001/9002,
# waits for mesh formation, fires one intent from run-user,
# and tails all four logs in a split terminal (using tmux or parallel).
node scripts/run-mesh.js &
sleep 2
node scripts/run-solver.js PORT=9000 &
node scripts/run-solver.js PORT=9001 &
node scripts/run-solver.js PORT=9002 &
sleep 3  # wait for gossipsub mesh
BOOTSTRAP_PEERS=... node scripts/run-user.js
```

**Commit-reveal verification** — when three solvers are running, the logs should show the commit phase (each solver sends a hash), then the reveal phase (each solver reveals bid+salt), then the winner selected by highest `outputAmount`. This is the key protocol property: no solver can snipe the winner at T=79ms because they committed at T=0.

---

## Phase 6 — Protocol Differentiation

**Goal:** Advance from "working demo" to "protocol with meaningful properties that nothing else has." This is where the libp2p-native design choices pay off.

### 6.1 — ERC-7683 adapter layer

ERC-7683 is the cross-chain intents standard co-authored by Uniswap and Across (2024), now supported by every serious intent protocol. It defines a `CrossChainOrder` struct:

```solidity
struct CrossChainOrder {
    address originSettler;
    address user;
    uint256 nonce;
    uint256 originChainId;
    uint32  openDeadline;
    uint32  fillDeadline;
    bytes32 orderDataType;
    bytes   orderData;
}
```

Lattice's `Intent` struct maps cleanly onto this: `inputToken`/`outputToken`/`inputAmount`/`minOutputAmount` go into `orderData`, `deadline` maps to `fillDeadline`, `topicTier` can be encoded in `orderDataType`. An adapter contract `ERC7683Adapter.sol` can decode a `CrossChainOrder`, reconstruct a Lattice `Intent`, and call `IntentSettlement.settle()`.

The strategic value: Lattice becomes the P2P coordination layer that any ERC-7683 compatible protocol can route through. Solvers running the Lattice mesh can fill UniswapX orders, Across orders, and native Lattice intents all through the same GossipSub topic — without changing the networking layer at all.

### 6.2 — QUIC transport

The current transport stack is `WebSocket + Noise XX + yamux`. QUIC replaces all three with a single protocol that gives 0-RTT connection establishment (versus one full round-trip for WebSocket), native stream multiplexing (removing yamux overhead), and connection migration (survives IP changes without reconnection, critical for solver nodes that run on cloud VMs).

Add QUIC alongside WebSocket rather than replacing it — the nodes negotiate the best available transport via multistream-select, so old connections continue working:

```js
import { webTransport } from '@libp2p/webtransport'
import { quic }         from '@helia/libp2p-quic'

const node = await createLibp2p({
  addresses: {
    listen: [
      `/ip4/0.0.0.0/tcp/${port}/ws`,        // existing WebSocket
      `/ip4/0.0.0.0/udp/${quicPort}/quic-v1`, // new QUIC
    ]
  },
  transports: [webSockets(), quic()],
  // rest unchanged
})
```

Expected gain: pre-warmed connection dial time drops from ~2ms to ~0.3ms (0-RTT), giving the auction coordinator more headroom. Measure with the latency harness from 5.3 before and after.

### 6.3 — GossipSub peer scoring tuned for solver behaviour

The current `scoreThresholds` in `gossipsub-config.js` are generic defaults. A solver-specific scoring policy should reward behaviours that improve mesh quality: staying subscribed, providing rapid responses to RFQ streams, and propagating valid intents forward. It should penalise invalid messages (which the validator already handles) and slow propagation.

The `p4` parameter (invalid message deliveries per topic) is the most important to tune for a DeFi mesh, because a solver that propagates spam or crafts invalid signatures should be ejected from the mesh quickly. Increasing the p4 weight and lowering the `graylistThreshold` makes this more aggressive.

Additionally, expose a `/lattice/1.0.0` diagnostic stream protocol that the coordinator can use to query a solver's current mesh score and peer connections — useful for the latency harness and for the frontend demo.

### 6.4 — Solver reputation and fill history

`SolverRegistry.sol` tracks `fills` but the `upgradeTier` path requires only `fills >= MIN_FILLS_TIER1`. A richer reputation model would weight recent fills more heavily than old ones (exponential decay), track successful vs attempted settlements (fill rate), and publish an on-chain reputation score that users can reference in their `preferredSolver` field.

This also enables a solver allowlist for private `tier1` topic flow: only solvers with a fill rate above a threshold over the last 30 days can access tier-1 intents. This maps directly to the libp2p peer scoring model — the on-chain reputation feeds into the GossipSub `p6` (application-specific score parameter).

---

## Phase 7 — Production Hardening

**Goal:** The protocol should be safe to deploy on Arbitrum mainnet, with economic security properties that make attacks unprofitable.

### 7.1 — Real IntentSettlement with pluggable execution strategies

Replace the `SwapRouter.exactInput` hard-coding with an `IExecutionStrategy` interface:

```solidity
interface IExecutionStrategy {
    function execute(
        address inputToken,
        address outputToken,
        uint256 inputAmount,
        uint256 minOutputAmount,
        address recipient,
        bytes calldata route
    ) external returns (uint256 amountOut);
}
```

`IntentSettlement` holds a registry of approved strategies. The solver's `bid.route` encodes both the strategy address and the strategy-specific path bytes. This means: Uniswap v3 is one strategy, Curve is another, a direct inventory transfer (CoW-style coincidence-of-wants) is a third. The settlement contract is execution-agnostic.

This also solves the testnet liquidity problem permanently — the "mock" strategy that was `MockIntentSettlement` becomes `DirectTransferStrategy`, a first-class production strategy for zero-slippage fills when a solver has inventory.

### 7.2 — Solver slashing conditions

Currently a solver can register, collect fills, then stop fulfilling bids with no consequence. Add slashable conditions:

The first slashable condition is a solver winning an auction (sending a bid via RFQ) but failing to submit the settlement transaction within a timeout window. The coordinator node can submit evidence of the unanswered bid on-chain to trigger a partial stake slash.

The second is a solver submitting a settlement that reverts on-chain — their `fill` count should not increment and they should incur a small slash for wasting gas. The settlement contract can read the transaction success status from the receipt.

Implement slashing via a `DisputeResolver.sol` that accepts signed evidence (the bid protobuf plus a block timestamp) and verifies the solver did not settle within the window.

### 7.3 — ZK proofs for solver compute (research phase)

In the current design, a solver claims "I can fill this intent for output X via route Y." The settlement contract trusts this claim by verifying that the actual swap returns `>= minOutputAmount`. But the bidding phase is still trust-based — the coordinator has no way to know whether a solver's bid is honest before executing on-chain.

A ZK proof of computation would let a solver commit to a specific output amount at bid time and prove that their routing algorithm would genuinely produce that output given the current pool state snapshot. This eliminates solver dishonesty in the bidding phase entirely.

The practical path uses a zkVM (Risc0 or SP1) running the Uniswap v3 quote math against a verifiable pool state snapshot (the pool state rooted in an EIP-1186 storage proof). The solver generates a proof alongside the bid; the coordinator verifies the proof before accepting the bid into the auction. On-chain verification can be deferred — the proof is kept off-chain unless a dispute is raised.

This is a research-phase item. A solid foundation is to first write a reference implementation of `estimateOutput` (from `compute-engine.js`) in Rust, then instrument it to run under Risc0 and produce a verifiable output, then measure proof generation time to see if it fits inside the auction window. The current estimate for simple arithmetic circuits in Risc0 is 20-60ms, which is tight but potentially feasible if compute is done in the commit phase.

### 7.4 — Cross-chain intents (Phase 8 horizon)

With ERC-7683 in place, extending to cross-chain is an additive change. The intent schema already has `topicTier` which can be extended to a `destinationChainId` field. The GossipSub mesh can carry intents for multiple chains on different sub-topics (`intents/v1/evm/42161/public` for Arbitrum mainnet, `intents/v1/evm/1/public` for Ethereum).

The settlement layer needs a cross-chain messaging protocol (Axelar, LayerZero, or Hyperlane) to prove that the destination fill happened before releasing the origin token. This is the standard optimistic bridge pattern, just with Lattice's RFQ layer sitting above it.

---

## Architecture invariants — never negotiate these

These are design decisions that should remain stable across all phases:

**Single canonical auction window.** The 80ms window is a protocol constant. Extending it for "complex" intents would allow timing attacks. If a category of intent genuinely needs more time, it gets a separate topic with an explicit different window — it does not change the shared constant.

**Nonces on the settlement contract.** `settlement.nonces(user)` is the one canonical read path for all clients. In v1 the value is stored in `SolverRegistry` and exposed via a passthrough view on `IntentSettlement`. In v2, storage moves to `IntentSettlement` directly (registry becomes solver-only). This eliminates the historical split.

**Signed bids are irrevocable.** A solver that submits a bid via the RFQ stream is committing to that bid for the duration of the auction. The commit-reveal scheme enforces this cryptographically. There is no bid cancellation mechanism.

**PeerID binds to exactly one EVM address.** The `SolverRegistry.register(peerId, tier)` mapping is 1:1. A solver running multiple nodes must register each PeerID separately. This prevents Sybil attack where one actor registers many PeerIDs to game the tier system.

**The P2P layer is settlement-agnostic.** GossipSub, the RFQ protocol, and the auction coordinator have no direct dependency on any specific settlement contract, chain, or DEX. They process intents and produce bids. What happens to winning bids is injected via `onWinner` — a pure function boundary.

---

## Testing matrix

Every phase should be testable at three levels before merging:

**Unit** — isolated logic. Solidity tests via Foundry for contracts. Node.js unit tests (using `vitest` or `node:test`) for `commitment.js` hash verification, `route-encoder.js` byte layout, `intent-codec.js` round-trip fidelity, `validators.js` reject/accept decisions.

**Integration** — two or more real nodes talking. The multi-node demo from 5.4 as a scripted integration test. Key assertions: did the intent arrive at the solver, did the auction close within 80ms, did the settlement tx land on-chain.

**Adversarial** — intentional failure injection. Send an intent with a bad signature and confirm the validator rejects it (TopicValidatorResult.Reject). Submit a bid below `minOutputAmount` and confirm the auction coordinator drops it. Submit a settlement after the intent deadline and confirm the contract reverts with `IntentExpired`. These should be part of the Foundry test suite from 5.2.

---

## Open questions (tracked, not deferred)

**Can `estimateOutput` cause solver collusion?** If all solvers use the same `sqrtPriceX96` formula against the same cached pool state, they will produce the same output estimate and the "competition" is effectively fake. The commit-reveal scheme prevents sniping but not bid convergence. The production fix is for each solver to add a configurable margin to their bid — or use the on-chain Quoter contract for more accurate (but slower) quotes.

**What happens during mesh partition?** If the solver mesh splits into two components that cannot see each other, intents published to one partition are invisible to solvers on the other. The Kademlia DHT helps with discovery but does not guarantee partition recovery. A production deployment should monitor `node.getPeers().length` and alert if it drops below `Dlo`.

**RFQ dial timeout (resolved).** `AbortSignal.timeout(60)` is **60 milliseconds**, not 60 seconds. The timeout is now env-configurable via `RFQ_DIAL_TIMEOUT_MS` (default 60ms for WebSocket — cold dial ~50ms, leaves 20ms coordinator window). When QUIC transport lands (Phase 6.2), set `RFQ_DIAL_TIMEOUT_MS=40` for ~40ms QUIC cold dial, giving the coordinator extra buffer. Pre-warm tracking per peer is in place as a hook point for per-connection adaptive timeouts.