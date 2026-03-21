// Track 2.2 — Locked GossipSub topic strings
// Chain ID (1) is baked in — prevents testnet/mainnet cross-contamination
export const TOPICS = {
    PUBLIC: 'intents/v1/evm/1/public',
    TIER1:  'intents/v1/evm/1/tier1',
    // PRIVATE RFQ deferred to Track 3.1:
    // rfq: (address) => `intents/v1/evm/1/rfq/${address.toLowerCase()}`
  }
  
  export function topicForIntent(intent) {
    return intent.topicTier === 1 ? TOPICS.TIER1 : TOPICS.PUBLIC
  }