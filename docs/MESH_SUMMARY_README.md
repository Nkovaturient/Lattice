# Mesh + settlement implementation summary

Concise changelog for **GossipSub mesh**, **Arbitrum Sepolia settlement**, **RPC stability**, **docs**.

## GossipSub / topics (`libp2p/topics.js`)

- Canonical topics: **`intents/v1/evm/1/public`**, **`intents/v1/evm/1/tier1`** (`topicTier` selects).
- `run-mesh.js` formerly subscribed the solver to a stale **`/lattice/...`** string — **aligned** to **`TOPICS.PUBLIC`** + **explicit user→solver dial** (bootstrap node has **no pubsub**; **`floodPublish: false`** needs a libp2p hop that runs GossipSub).

## Scripts

| Piece | Behavior |
|---|---|
| **`scripts/run-user.js`** | Registry alias **`SOLVER_REGISTRY_ADDRESS`**; **`createRatedJsonRpcProvider`**; nonce log; **`BOOTSTRAP_PEERS`** dial + mesh wait before publish. |
| **`scripts/run-solver.js`** | Settlement alias **`INTENT_SETTLEMENT_ADDRESS`**; registry alias **`SOLVER_REGISTRY_ADDRESS`**; rated provider; **`localCompute`** wired to **`attachAuctionCoordinator`** (`AUTO_SETTLE` → `submitSettlement`). |

## Settlement (`node/settlement-submit.js`, `contracts`)

- **`submitSettlement`** — tuple normalization (**`ethers.getAddress`**, **`BigInt`** for `uint256`), **`staticCall` → optional `estimateGas`**, Arbiscan explorer lines.
- **`SETTLE_GAS_LIMIT`** — optional skip **`estimateGas`** after **`staticCall`** (fewer RPC calls).
- Revert decoding: **`Error(string)`**, **`Panic`**, **`IntentSettlement`** custom errors where present; opaque hex often means **callee sans message** (**Uniswap `/ exactInput`**).
- **`scripts/settle.js`** — delegates to **`submitSettlement`**; env aliases for URLs / settlement addr.

## Auction (`node/auction.js`)

- **`localCompute`** branch when **`solverPeers` empty** → **solo solver demo** (`computeSolution` → bid verify → **`onWinner`**).
- **`onWinner`** guarded with **`try/catch`** (`[auction] onWinner/settlement:`) so **`submitSettlement`/RPC faults** don’t derail gossip handling; **`run-solver`** forwards **`submitSettlement`** without a duplicate outer catch.

## RFQ internals (`libp2p/rfq-internal.js`)

- **Unchanged**: length-prefixed stream framing **`readFramed` / `writeFramed`** for **`/defi/rfq/1.0.0`**.

## Solver node wiring (`node/solver.js`)

- **`createSolverNode`** — validators, **`TOPICS.PUBLIC`/tier1**, **`computeSolution`** inject, **`registerRFQHandler`** unchanged by this wave; **`run-solver.js`** attaches **auction** + **rated RPC** externally.

## RPC (`node/rpc-provider.js`)

- **`batchMaxCount: 1`**, **`staticNetwork`**, tunable **`RPC_POLLING_INTERVAL_MS`**.
- **`withRpcRetries`**: exponential backoff **+ `RPC_429_EXTRA_MS`** (default bumps **~63s** when response body mentions **429** / rate-limit) so public Arbitrum “reset in 60 seconds” windows aren’t exhausted by fast retries alone.

---

**Honest takeaway for demos**: mesh + EIP-712 can work while **`settle`/`eth_call`** fail — **infra (RPC limits, SwapRouter semantics)** versus **coordination**.
