// Track 1.1 + 3.1 — Solver node bootstrap with RFQ handler injection
import { createLibp2p } from 'libp2p'
import { webSockets } from '@libp2p/websockets'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { gossipsub } from '@libp2p/gossipsub'
import { identify } from '@libp2p/identify'
import { ping } from '@libp2p/ping'
import { kadDHT } from '@libp2p/kad-dht'
import {bootstrap} from '@libp2p/bootstrap'
import { GOSSIP_CONFIG } from '../libp2p/gossipsub-config.js'
import { attachIntentValidators } from '../libp2p/validators.js'
import { SolverRegistryCache } from '../libp2p/registry-cache.js'
import { TOPICS } from '../libp2p/topics.js'
import { registerRFQHandler } from '../libp2p/rfq-protocol.js'
import { initCodec } from '../sdk/intent-codec.js'

/**
 * Create and start a solver node.
 *
 * config shape:
 * {
 *   port:             number,          // WebSocket listen port (default 9000)
 *   tier:             0 | 1,           // GossipSub topic tier
 *   bootstrapList:    string[],        // multiaddr strings for bootstrap peers
 *   solverPeers:      { multiaddr }[], // pre-warm these connections at startup
 *   registryContract: ethers.Contract, // SolverRegistry on-chain
 *   provider:         ethers.Provider,
 *   computeSolution:  Function,        // injected DEX engine — see below
 * }
 *
 * computeSolution signature (Track 3.3):
 *   async (intent) => {
 *     solverAddress: string,      // EVM address of this solver
 *     outputAmount:  string,      // guaranteed output as uint256 string
 *     encodedRoute:  Uint8Array,  // ABI-encoded Uniswap v3 path
 *     signature:     string,      // EIP-712 bid sig (from bid-builder.js)
 *   } | null                      // null = cannot fill this intent
 */
export async function createSolverNode(config) {
  // Pre-warm proto loader before any gossip or RFQ arrives
  await initCodec()

  const node = await createLibp2p({
    addresses: {
      listen: [`/ip4/0.0.0.0/tcp/${config.port ?? 9000}/ws`],
    },
    transports: [webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      ping:     ping(),
      pubsub:   gossipsub(GOSSIP_CONFIG),
      dht:      kadDHT({ clientMode: false }),
    },
    connectionManager: {
      maxConnections:      50,
      minConnections:      5,
      autoDialConcurrency: 4,
    },
    peerDiscovery: [
      ...(config.bootstrapList?.length
        ? [bootstrap({ list: config.bootstrapList })]
        : []),
    ]
  })

  await node.start()
  console.log(`[solver] started — ${node.peerId}`)
  console.log(`[solver] listening on:`, node.getMultiaddrs().map(a => a.toString()))

  // Track 2.3 — attach gossip topic validators
  const registryCache = new SolverRegistryCache(
    config.registryContract,
    config.provider
  )
  attachIntentValidators(node, registryCache)

  // Subscribe to intent topics based on solver tier
  node.services.pubsub.subscribe(TOPICS.PUBLIC)
  if (config.tier === 1) {
    node.services.pubsub.subscribe(TOPICS.TIER1)
    console.log(`[solver] subscribed to tier-1 topic`)
  }

  // Track 3.1 — register /defi/rfq/1.0.0 with injected compute engine
  if (typeof config.computeSolution === 'function') {
    registerRFQHandler(node, config.computeSolution)
    console.log(`[solver] RFQ handler registered`)
  } else {
    console.warn(`[solver] no computeSolution injected — RFQ handler not registered`)
  }

  // Pre-warm connections to known solver peers (sub-100ms auction requirement)
  if (config.solverPeers?.length) {
    await _prewarmConnections(node, config.solverPeers)
  }

  return node
}

async function _prewarmConnections(node, peers) {
  const results = await Promise.allSettled(
    peers.map(({ multiaddr }) => node.dial(multiaddr))
  )
  const ok   = results.filter(r => r.status === 'fulfilled').length
  const fail = results.filter(r => r.status === 'rejected').length
  console.log(`[solver] pre-warmed ${ok}/${ok + fail} peers`)

  // Refresh every 30s — keep connections hot
  setInterval(
    () => Promise.allSettled(peers.map(({ multiaddr }) => node.dial(multiaddr))),
    30_000
  )
}