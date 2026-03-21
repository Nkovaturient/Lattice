#!/usr/bin/env node
// scripts/run-user.js — Build + broadcast a real signed intent to the mesh
// Usage:
//   PRIVATE_KEY=0x... ARB_SEPOLIA_RPC=https://... \
//   SETTLEMENT_CONTRACT_ADDRESS=0x... \
//   INPUT_TOKEN=0x... OUTPUT_TOKEN=0x... INPUT_AMOUNT=1000000 MIN_OUTPUT=900000 \
//   node scripts/run-user.js

import { ethers } from 'ethers'
import { createLibp2p } from 'libp2p'
import { webSockets } from '@libp2p/websockets'
import { all } from '@libp2p/websockets/filters'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { bootstrap } from '@libp2p/bootstrap'
import { initCodec, encodeIntent } from '../src/sdk/intent-codec.js'
import { computeIntentId } from '../src/sdk/intent-id.js'
import { topicForIntent } from '../src/p2p/topics.js'

// ── Env ───────────────────────────────────────────────────────────────────────
const {
  PRIVATE_KEY,
  ARB_SEPOLIA_RPC,
  SETTLEMENT_CONTRACT_ADDRESS,
  BOOTSTRAP_PEERS,
  INPUT_TOKEN,
  OUTPUT_TOKEN,
  INPUT_AMOUNT,
  MIN_OUTPUT,
  TOPIC_TIER = '0',
} = process.env

if (!PRIVATE_KEY || !ARB_SEPOLIA_RPC || !INPUT_TOKEN || !OUTPUT_TOKEN || !INPUT_AMOUNT || !MIN_OUTPUT) {
  console.error('Required: PRIVATE_KEY, ARB_SEPOLIA_RPC, INPUT_TOKEN, OUTPUT_TOKEN, INPUT_AMOUNT, MIN_OUTPUT')
  process.exit(1)
}

const REGISTRY_ABI = [
  'function nonces(address) view returns (uint256)',
]

const DOMAIN_ARB_SEPOLIA = {
  name:              'IntentDeFi',
  version:           '1',
  chainId:           421614,
  verifyingContract: SETTLEMENT_CONTRACT_ADDRESS ?? ethers.ZeroAddress,
}

const INTENT_TYPE = {
  Intent: [
    { name: 'user',            type: 'address' },
    { name: 'nonce',           type: 'uint256' },
    { name: 'inputToken',      type: 'address' },
    { name: 'outputToken',     type: 'address' },
    { name: 'inputAmount',     type: 'uint256' },
    { name: 'minOutputAmount', type: 'uint256' },
    { name: 'recipient',       type: 'address' },
    { name: 'deadline',        type: 'uint64'  },
    { name: 'topicTier',       type: 'uint8'   },
    { name: 'preferredSolver', type: 'address' },
  ],
}

async function main() {
  const provider = new ethers.JsonRpcProvider(ARB_SEPOLIA_RPC)
  const wallet   = new ethers.Wallet(PRIVATE_KEY, provider)

  console.log(`[user] address: ${wallet.address}`)
  console.log(`[user] swap: ${INPUT_AMOUNT} of ${INPUT_TOKEN} → min ${MIN_OUTPUT} of ${OUTPUT_TOKEN}`)

  await initCodec()

  // ── Fetch on-chain nonce ───────────────────────────────────────────────────
  let nonce = 0n
  if (SETTLEMENT_CONTRACT_ADDRESS && SETTLEMENT_CONTRACT_ADDRESS !== ethers.ZeroAddress) {
    const registry = new ethers.Contract(SETTLEMENT_CONTRACT_ADDRESS, REGISTRY_ABI, provider)
    nonce = await registry.nonces(wallet.address)
  }

  // ── Build intent ──────────────────────────────────────────────────────────
  const intentData = {
    user:            wallet.address,
    nonce:           nonce.toString(),
    inputToken:      INPUT_TOKEN,
    outputToken:     OUTPUT_TOKEN,
    inputAmount:     INPUT_AMOUNT,
    minOutputAmount: MIN_OUTPUT,
    recipient:       wallet.address,
    deadline:        Math.floor(Date.now() / 1000) + 600,
    topicTier:       Number(TOPIC_TIER),
    preferredSolver: ethers.ZeroAddress,
  }

  // ── Sign with EIP-712 ─────────────────────────────────────────────────────
  const signature = await wallet.signTypedData(DOMAIN_ARB_SEPOLIA, INTENT_TYPE, intentData)
  const intentId  = computeIntentId(intentData)
  const intent    = { ...intentData, intentId, signature }

  console.log(`[user] intentId: ${intentId.slice(0, 18)}…`)
  console.log(`[user] deadline: ${new Date(intentData.deadline * 1000).toISOString()}`)

  // ── Encode for wire ───────────────────────────────────────────────────────
  const wireBytes = await encodeIntent(intent)
  console.log(`[user] encoded: ${wireBytes.length}B`)

  // ── Spin up a minimal libp2p user node ────────────────────────────────────
  const node = await createLibp2p({
    addresses: { listen: ['/ip4/0.0.0.0/tcp/0/ws'] },
    transports: [webSockets({ filter: all })],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify() },
    peerDiscovery: BOOTSTRAP_PEERS
      ? [bootstrap({ list: BOOTSTRAP_PEERS.split(',').map(s => s.trim()) })]
      : [],
  })

  await node.start()
  console.log(`[user] p2p node started: ${node.peerId}`)

  // Wait for at least one peer connection
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('No peers connected within 10s')), 10_000)
    node.addEventListener('peer:connect', () => {
      clearTimeout(timeout)
      resolve()
    }, { once: true })
  })

  const topic = topicForIntent(intent)
  console.log(`[user] publishing to topic: ${topic}`)

  // Publish intent to GossipSub mesh
  await node.services.pubsub.publish(topic, wireBytes)

  console.log(`[user] intent broadcast — waiting for solver bids...`)
  console.log(`[user] (check run-solver.js terminal for auction activity)`)

  // Stay alive for 30s to allow solvers to respond
  await new Promise(r => setTimeout(r, 30_000))

  await node.stop()
  console.log('[user] done')
}

main().catch(e => { console.error(e.message); process.exit(1) })