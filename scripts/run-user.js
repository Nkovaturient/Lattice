// Build + broadcast a real signed intent to the mesh
import 'dotenv/config'
import { ethers } from 'ethers'
import { createLibp2p } from 'libp2p'
import { webSockets } from '@libp2p/websockets'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { gossipsub } from '@libp2p/gossipsub'
import { bootstrap } from '@libp2p/bootstrap'
import { multiaddr } from '@multiformats/multiaddr'
import { initCodec, encodeIntent } from '../sdk/intent-codec.js'
import { computeIntentId } from '../sdk/intent-id.js'
import { DOMAIN, INTENT_TYPE } from '../sdk/domain.js'
import { topicForIntent } from '../libp2p/topics.js'
import { GOSSIP_CONFIG } from '../libp2p/gossipsub-config.js'
import { SolverRegistryABI } from '../ABI/SolverRegistryABI.js'

// ── Arb Sepolia defaults (Uniswap test tokens) ───────────────────────────────
const DEFAULT_SWAP = {
  INPUT_TOKEN:     '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', // USDC
  OUTPUT_TOKEN:    '0x980B62Da83eFf3D4576C647993b0c1D7faf17c73', // WETH
  INPUT_AMOUNT:    '1000000',              // 1 USDC (6 decimals)
  MIN_OUTPUT:      '100000000000000',     // 0.0001 WETH (18 decimals) floor
}

// ── Env ───────────────────────────────────────────────────────────────────────
const {
  PRIVATE_KEY,
  ARB_SEPOLIA_RPC,
  REGISTRY_CONTRACT_ADDRESS,
  BOOTSTRAP_PEERS,
  INPUT_TOKEN,
  OUTPUT_TOKEN,
  INPUT_AMOUNT,
  MIN_OUTPUT,
  TOPIC_TIER = '0',
} = process.env

if (!PRIVATE_KEY || !ARB_SEPOLIA_RPC) {
  console.error('Required: PRIVATE_KEY, ARB_SEPOLIA_RPC (e.g. in .env)')
  process.exit(1)
}

const inputToken      = INPUT_TOKEN?.trim()      || DEFAULT_SWAP.INPUT_TOKEN
const outputToken     = OUTPUT_TOKEN?.trim()     || DEFAULT_SWAP.OUTPUT_TOKEN
const inputAmount     = INPUT_AMOUNT?.trim()     || DEFAULT_SWAP.INPUT_AMOUNT
const minOutputAmount = MIN_OUTPUT?.trim()       || DEFAULT_SWAP.MIN_OUTPUT


/** Subscription RPCs received — peer is in our topic view (required before mesh graft). */
async function waitForTopicSubscribers(pubsub, topic, { timeoutMs = 30_000, intervalMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pubsub.getSubscribers(topic).length > 0) {
      console.log(`[user] GossipSub: remote peer(s) subscribed to ${topic}`)
      return
    }
    await new Promise(r => setTimeout(r, intervalMs))
  }
  throw new Error(
    `Timeout waiting for topic subscribers on "${topic}". ` +
      'Ensure the solver is running and BOOTSTRAP_PEERS matches its multiaddr.'
  )
}

/** At least one mesh link on topic (floodPublish off — publish uses mesh/fanout only). */
async function waitForGossipsubMesh(pubsub, topic, { timeoutMs = 45_000, intervalMs = 200 } = {}) {
  const getMesh = pubsub.getMeshPeers?.bind(pubsub)
  if (typeof getMesh !== 'function') {
    throw new Error('Expected GossipSub service with getMeshPeers()')
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const n = getMesh(topic).length
    if (n > 0) {
      console.log(`[user] GossipSub mesh: ${n} peer(s) on ${topic}`)
      return
    }
    await new Promise(r => setTimeout(r, intervalMs))
  }
  throw new Error(
    `Timeout waiting for GossipSub mesh on "${topic}". ` +
      'Solver must subscribe to the same topic; check heartbeats / peer score.'
  )
}

async function main() {
  const provider = new ethers.JsonRpcProvider(ARB_SEPOLIA_RPC)
  const wallet   = new ethers.Wallet(PRIVATE_KEY, provider)
  const network  = await provider.getNetwork()
  const chainId = Number(network.chainId)
  if (chainId !== DOMAIN.chainId) {
    console.warn(
      `[user] RPC chainId ${chainId} ≠ DOMAIN.chainId ${DOMAIN.chainId} — set CHAIN_ID or ARB_SEPOLIA_CHAIN_ID in .env`
    )
  }

  console.log(`[user] address: ${wallet.address}`)
  console.log(`[user] chain: ${chainId} (EIP-712 domain uses ${DOMAIN.chainId})`)
  console.log(`[user] swap: ${inputAmount} ${inputToken.slice(0, 10)}… → min ${minOutputAmount} ${outputToken.slice(0, 10)}…`)

  await initCodec()

  let nonce = 0n
  const registryAddr = REGISTRY_CONTRACT_ADDRESS?.trim()
  if (registryAddr) {
    const registry = new ethers.Contract(registryAddr, SolverRegistryABI, provider)
    nonce = await registry.nonces(wallet.address)
  } else {
    console.warn('[user] REGISTRY_CONTRACT_ADDRESS not set — using nonce 0 (set for real settlement)')
  }

  const intentData = {
    user:            wallet.address,
    nonce:           nonce.toString(),
    inputToken,
    outputToken,
    inputAmount,
    minOutputAmount,
    recipient:       wallet.address,
    deadline:        Math.floor(Date.now() / 1000) + 600,
    topicTier:       Number(TOPIC_TIER),
    preferredSolver: ethers.ZeroAddress,
  }

  const signature = await wallet.signTypedData(DOMAIN, INTENT_TYPE, intentData)
  const intentId  = computeIntentId(intentData)
  const intent    = { ...intentData, intentId, signature }

  console.log(`[user] intentId: ${intentId.slice(0, 18)}…`)
  console.log(`[user] deadline: ${new Date(intentData.deadline * 1000).toISOString()}`)

  const wireBytes = await encodeIntent(intent)
  console.log(`[user] encoded: ${wireBytes.length}B`)

  const bootstrapList = BOOTSTRAP_PEERS
    ? BOOTSTRAP_PEERS.split(',').map(s => s.trim()).filter(Boolean)
    : []

  if (bootstrapList.length === 0) {
    console.error(
      '[user] BOOTSTRAP_PEERS is required — set to your solver listen multiaddr, e.g.\n' +
        '  BOOTSTRAP_PEERS=/ip4/127.0.0.1/tcp/9000/ws/p2p/<solverPeerId>'
    )
    process.exit(1)
  }

  const node = await createLibp2p({
    addresses: { listen: ['/ip4/0.0.0.0/tcp/0/ws'] },
    transports: [webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      pubsub:   gossipsub(GOSSIP_CONFIG),
    },
    peerDiscovery: [bootstrap({ list: bootstrapList })],
  })

  await node.start()
  console.log(`[user] p2p node started: ${node.peerId}`)

  // Explicit dial: bootstrap discovery alone can be slow; solver must be listening.
  for (const addr of bootstrapList) {
    try {
      await node.dial(multiaddr(addr))
      console.log(`[user] dialed ${addr.slice(0, 52)}…`)
    } catch (e) {
      console.warn(`[user] dial ${addr.slice(0, 40)}… failed:`, e.message)
    }
  }

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () =>
        reject(
          new Error(
            'No peers connected within 60s. Causes: (1) solver not running or crashed (e.g. RPC 429), ' +
              '(2) wrong multiaddr / PeerID after solver restart, (3) firewall — try 127.0.0.1 if same machine.'
          )
        ),
      60_000
    )
    if (node.getPeers().length > 0) {
      clearTimeout(timeout)
      resolve()
      return
    }
    node.addEventListener('peer:connect', () => {
      clearTimeout(timeout)
      resolve()
    }, { once: true })
  })

  // Let both sides open meshsub streams and exchange subscription RPCs (avoids NoPeersSubscribedToTopic).
  await new Promise(r => setTimeout(r, 400))

  const topic = topicForIntent(intent)
  console.log(`[user] subscribing to topic: ${topic}`)

  await node.services.pubsub.subscribe(topic)
  await waitForTopicSubscribers(node.services.pubsub, topic)
  await waitForGossipsubMesh(node.services.pubsub, topic)

  console.log(`[user] publishing intent (mesh path, floodPublish off)…`)
  await node.services.pubsub.publish(topic, wireBytes)

  console.log(`[user] intent broadcast — check solver terminal for auction / RFQ`)
  await new Promise(r => setTimeout(r, 30_000))

  await node.stop()
  console.log('[user] done')
}

main().catch(e => { console.error(e.message); process.exit(1) })
