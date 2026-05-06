## Strategical Decisions

1. **Expand Phase B** with Quoter **latency measurement**, **auction-timeline caveat**, and **margin + optional Quoter** policy.  
2. **Add a “Mesh partition / production ops”** subsection (monitoring + topology + fallbacks).  
3. **Add RFQ dial timeout** subsection: **60 ms today**, env-driven values, QUIC vs WS after benchmarks; fix any “60s” confusion.


## 1) `estimateOutput` “collusion” and Quoter

**Yes, identical pool math + identical cache can collapse bids.** Commit–reveal stops **ordering / sniping** around a known winning quote; it does **not** force **dispersion** in the underlying quote. If everyone runs the same `estimateOutput` on the same snapshot, revealed prices can still be the same (or within rounding), so “competition” is weak unless you add **heterogeneity** (private margin, private inventory, different routes, or **on-chain Quoter** / fresher state).

**QuoterV2** (`0x61fFE014bA17989E743c5F6cB21bF9697530B21e` in [`IntentSettlement.sol`](Gossamer/contracts/src/IntentSettlement.sol)) is a good lever: it tracks **consensus chain state** at read time, not your local cache, so bids track each other less naively than a shared off-chain formula. It does **not** remove all convergence (same chain, same pools → often similar quotes).

**Latency nuance (important for your sentence “after 80ms”):**  
On the **multi-solver RFQ** path, the winning bid is produced while the auction is running: [`requestBid`](Gossamer/libp2p/rfq-protocol.js) opens a stream, sends the intent, then reads the bid. The solver’s **`computeSolution`** (where you’d add Quoter) runs **inside that window**, not only “after the 80ms window closes.” So each **`eth_call` to Quoter** can eat part of the **per-solver** budget; slow RPC can hurt **time-to-bid**, not just settlement.  

On **solo** [`localCompute`](Gossamer/node/auction.js) (no remote RFQ), there is no parallel `requestBid` dial budget in the same way, but the coordinator still closes the auction quickly—so Quoter cost still matters for **responsiveness**, just with a different shape.

**Plan calibration (what to add):**  
- Instrument **p50/p95** of `quoteExactInput` staticcall on **your production RPC** (Arbitrum Sepolia vs mainnet).  
- Gate: if p95 is **small vs your auction budget**, make Quoter **default on** for signing; if not, use **margin on `estimateOutput`** for the hot path and Quoter only for **preflight** / **tier-1** / **optional** flag.  
- Keep **configurable solver margin** anyway—Quoter does not replace strategic shading.

---

## 2) Mesh partition: monitoring + more than alerts

**Correct:** if GossipSub partitions, intents on one side never reach solvers on the other; DHT/bootstrap helps **discovery**, not **partition inevitability**.

**Production-oriented additions beyond `getPeers().length < D_lo` alert:**

- **Topology:** multiple **independent bootstrap / relay** nodes; solvers **redial** with backoff; avoid single rendezvous.  
- **GossipSub:** stronger **mesh** (more peers, tuned `D` / `D_lo` / scoring per ROADMAP 6.3); consider **floodPublish** only if you accept bandwidth cost for critical topics.  
- **Application fallbacks:** user **retries** with jitter; **secondary topic** or **backup coordinator**; optional **degraded path** (e.g. HTTPS intent relay with clear trust model—only if you accept non-pure-mesh).  
- **Metrics:** track **mesh peer count per topic**, **graft/prune** events, **publish errors** (e.g. `NoPeersSubscribedToTopic`), not just raw `getPeers()`.

**Plan update:** add a short **“Phase: mesh resilience & partition handling”** (ops + optional relay), separate from contract work.

---

## 3) RFQ timeout: 60ms (not 60s) — transport-aware (resolved)

In the repo, [`requestBid`](Gossamer/libp2p/rfq-protocol.js) uses:

```106:107:Gossamer/libp2p/rfq-protocol.js
    stream = await node.dialProtocol(peerId, RFQ_PROTOCOL, {
      signal: AbortSignal.timeout(60),
```

`AbortSignal.timeout` takes **milliseconds**, so this is **60 ms**, not 60 seconds. The comment on line 99 is consistent (“60ms … 20ms for the coordinator”).

So your “**60s for WebSocket**” label doesn’t match this file; it’s **60 ms dial timeout** for opening the RFQ stream.  

**QUIC / WebTransport (when you add it):** it’s reasonable to make this **configurable** (e.g. `RFQ_DIAL_TIMEOUT_MS`), with **defaults** tuned per transport after measurement—e.g. **60 ms** for cold WebSocket paths, **40 ms** (or lower) when connections are **pre-warmed** or QUIC 0-RTT is in play. The important part is **measure on your mesh**, not fix 40 ms as magic without data.

**Plan update:** replace any “60s” wording with **60 ms** for the current constant; add **env-based tuning** and a **bench note** (ROADMAP 5.3) for dial + stream phases.
