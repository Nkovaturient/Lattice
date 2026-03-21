#!/usr/bin/env node
// scripts/run-solver.js — Real solver node on Arbitrum Sepolia
// Usage:
//   PRIVATE_KEY=0x... ARB_SEPOLIA_RPC=https://... \
//   SETTLEMENT_CONTRACT_ADDRESS=0x... REGISTRY_CONTRACT_ADDRESS=0x... \
//   node scripts/run-solver.js

import { ethers } from 'ethers'
import { createSolverNode } from '../src/node/solver.js'
import { createComputeEngine, PoolStateCache, UNISWAP_V3 } from '../src/node/compute-engine.js'
import { attachAuctionCoordinator } from '../src/node/auction.js'
import { initCodec } from '../src/sdk/intent-codec.js'

// ── Env ───────────────────────────────────────────────────────────────────────
const {
  PRIVATE_KEY,
  ARB_SEPOLIA_RPC,
  SETTLEMENT_CONTRACT_ADDRESS,
  REGISTRY_CONTRACT_ADDRESS,
  BOOTSTRAP_PEERS,         // comma-separated multiaddrs of bootstrap nodes
  SOLVER_PORT = '9000',
  SOLVER_TIER = '1',
} = process.env

if (!PRIVATE_KEY || !ARB_SEPOLIA_RPC) {
  console.error('Required: PRIVATE_KEY, ARB_SEPOLIA_RPC')
  process.exit(1)
}

// ── ABIs (minimal) ────────────────────────────────────────────────────────────
const REGISTRY_ABI = [
  'function isRegistered(address) view returns (bool)',
  'function isActiveAndStaked(address) view returns (bool)',
  'function peerIdToAddress(string) view returns (address)',
  'function nonces(address) view returns (uint256)',
  'event SolverRegistered(address indexed solver, string peerId)',
  'event SolverSlashed(address indexed solver, uint256 amount, string reason)',
  'event SolverDeregistered(address indexed solver)',
]

// ── Well-known Arbitrum Sepolia Uniswap v3 pools to watch ────────────────────
// These are the pools whose state gets cached on every block
const WATCHED_POOLS_ARB_SEPOLIA = [
  // USDC/WETH 0.3%  — most liquid general-purpose pool
  '0x6337CAef1BB4B8E93C65aCD7f4BEB9E52a908A30',
  // WETH/USDT 0.3%
  '0x641C00A822e8b671738d32a431a4Fb6074E5c79d',
]

async function main() {
  const provider = new ethers.JsonRpcProvider(ARB_SEPOLIA_RPC)
  const wallet   = new ethers.Wallet(PRIVATE_KEY, provider)
  const network  = await provider.getNetwork()

  console.log(`[solver] chain: ${network.name} (${network.chainId})`)
  console.log(`[solver] address: ${wallet.address}`)
  console.log(`[solver] balance: ${ethers.formatEther(await provider.getBalance(wallet.address))} ETH`)

  await initCodec()

  // ── Pool state cache — real on-chain reads ────────────────────────────────
  const poolCache = new PoolStateCache(provider)
  await poolCache.start(WATCHED_POOLS_ARB_SEPOLIA)

  // ── Registry contract ─────────────────────────────────────────────────────
  const registryContract = REGISTRY_CONTRACT_ADDRESS
    ? new ethers.Contract(REGISTRY_CONTRACT_ADDRESS, REGISTRY_ABI, provider)
    : null

  if (!registryContract) {
    console.warn('[solver] REGISTRY_CONTRACT_ADDRESS not set — tier-1 admission disabled')
  }

  // ── Compute engine — real Uniswap v3 pathfinding ──────────────────────────
  const computeSolution = createComputeEngine(wallet, poolCache)

  // ── Bootstrap peers ───────────────────────────────────────────────────────
  const bootstrapList = BOOTSTRAP_PEERS
    ? BOOTSTRAP_PEERS.split(',').map(s => s.trim())
    : []

  // ── Start libp2p solver node ──────────────────────────────────────────────
  const node = await createSolverNode({
    port:             Number(SOLVER_PORT),
    tier:             Number(SOLVER_TIER),
    bootstrapList,
    solverPeers:      [], // add peer multiaddrs here once known
    registryContract,
    provider,
    computeSolution,
  })

  // ── Auction coordinator — submits winning tx ──────────────────────────────
  attachAuctionCoordinator(node, {
    solverPeers: [],
    selfAddress: wallet.address,
    onWinner: async (bid, intent) => {
      console.log(`[auction] winner selected — submitting settlement tx`)
      console.log(`  intentId: ${bid.intentId.slice(0, 18)}…`)
      console.log(`  output:   ${bid.outputAmount}`)

      // Settlement tx submission is in settle.js
      // In a full deployment, import and call submitSettlement() here
      console.log(`[auction] run: node scripts/settle.js with bid data above`)
    },
  })

  console.log(`\n[solver] ready — listening on port ${SOLVER_PORT}`)
  console.log(`[solver] PeerID: ${node.peerId}`)
  console.log(`[solver] multiaddrs:`)
  node.getMultiaddrs().forEach(a => console.log(`  ${a}`))
  console.log('\n[solver] waiting for intents...\n')

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n[solver] shutting down...')
    poolCache.stop()
    await node.stop()
    process.exit(0)
  })
}

main().catch(e => { console.error(e.message); process.exit(1) })