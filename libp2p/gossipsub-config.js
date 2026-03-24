// Track 2.2 — GossipSub config tuned for sub-100ms, 10–30 solver nodes
import { intentMessageId } from '../sdk/intent-id.js'

export const GOSSIP_CONFIG = {
  emitSelf:            false,  // never process own published intents
  gossipIncoming:      true,   // relay gossip to mesh peers
  fallbackToFloodsub:  false,  // pure gossipsub — no flood fallback
  floodPublish:        false, // mesh + fanout only (see libp2p/topics.js — intents/v1/evm/1/public)

  // Mesh degree — lower than default (6) for small trusted solver subnet
  D:      4,  // target mesh peers
  Dlo:    2,  // min before grafting
  Dhi:    6,  // max before pruning
  Dscore: 2,  // min score-qualified peers

  heartbeatInterval: 500,     // ms — faster mesh quality re-evaluation
  fanoutTTL:         60_000,
  mcacheLength:      6,
  mcacheGossip:      3,

  asyncValidation: true,       // required for topicValidators
  messageIdFn:     intentMessageId,

  scoreThresholds: {
    gossipThreshold:                 -10,
    publishThreshold:                -50,
    graylistThreshold:               -80,
    acceptPXThreshold:               0,
    opportunisticGraftThreshold:     1,
  },
}