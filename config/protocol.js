// Hardcoded protocol constants — never user-configurable
export const PROTOCOL = {
  AUCTION_WINDOW_MS: 80,      // fixed solver compute budget
  MAX_DEADLINE_OFFSET_SEC: 600,     // 10 min max intent lifetime
  MIN_DEADLINE_OFFSET_SEC: 60,      // must survive until settlement tx lands
  REGISTRY_CACHE_TTL_MS: 60_000,  // 5× mainnet block time
  GOSSIP_MESH_D: 4,       // tuned for 10–30 solver nodes
  GOSSIP_HEARTBEAT_MS: 500,
  SOLVER_RFQ_TIMEOUT_MS: 60,      // per-solver timeout in auction
}