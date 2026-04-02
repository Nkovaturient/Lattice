// scripts/run-solver.js — Real solver node on Arbitrum Sepolia
import 'dotenv/config'
import { ethers, Network } from 'ethers'
import { createSolverNode } from '../node/solver.js'
import { createComputeEngine, PoolStateCache } from '../node/compute-engine.js'
import { attachAuctionCoordinator } from '../node/auction.js'
import { initCodec } from '../sdk/intent-codec.js'
import { SolverRegistryABI } from '../ABI/SolverRegistryABI.js'

// ── Env ───────────────────────────────────────────────────────────────────────
const {
  PRIVATE_KEY,
  ARB_SEPOLIA_RPC,
  SETTLEMENT_CONTRACT_ADDRESS,
  REGISTRY_CONTRACT_ADDRESS,
  BOOTSTRAP_PEERS,         // comma-separated multiaddrs of bootstrap nodes
  SOLVER_PORT = '9000',
  SOLVER_TIER = '0',
} = process.env

if (!PRIVATE_KEY || !ARB_SEPOLIA_RPC) {
  console.error('Required: PRIVATE_KEY, ARB_SEPOLIA_RPC')
  process.exit(1)
}

// ── Arbitrum Sepolia Uniswap v3 pools (factory 0x248AB79…0188e) ─────────────
// Resolved via getPool — not Arbitrum One mainnet pool addresses.
const WATCHED_POOLS_ARB_SEPOLIA = [
  '0x66EEAB70aC52459Dd74C6AD50D578Ef76a441bbf', // USDC/WETH 0.3%
  '0x6F112d524DC998381C09b4e53C7e5e2cc260f877', // USDC/WETH 0.05%
]

async function main() {
  const chainIdNum = Number(process.env.ARB_SEPOLIA_CHAIN_ID ?? process.env.CHAIN_ID ?? 421614)
  const provider = new ethers.JsonRpcProvider(ARB_SEPOLIA_RPC, Network.from(chainIdNum), {
    staticNetwork:   true,
    pollingInterval: 12_000,
  })
  const wallet  = new ethers.Wallet(PRIVATE_KEY, provider)
  const network = await provider.getNetwork()

  console.log(`[solver] chain: ${network.name} (${network.chainId})`)
  console.log(`[solver] address: ${wallet.address}`)
  console.log(`[solver] balance: ${ethers.formatEther(await provider.getBalance(wallet.address))} ETH`)

  await initCodec()

  // ── Pool state cache — real on-chain reads ────────────────────────────────
  const poolCache = new PoolStateCache(provider)
  await poolCache.start(WATCHED_POOLS_ARB_SEPOLIA)

  // ── Registry contract ─────────────────────────────────────────────────────
  const registryContract = REGISTRY_CONTRACT_ADDRESS
    ? new ethers.Contract(REGISTRY_CONTRACT_ADDRESS, SolverRegistryABI, provider)
    : null

  if (!registryContract) {
    console.warn('[solver] REGISTRY_CONTRACT_ADDRESS not set — tier-1 admission disabled')
  }

  // ── Compute engine — real Uniswap v3 pathfinding ──────────────────────────
  const computeSolution = createComputeEngine(wallet, poolCache)

  // ── Bootstrap peers (optional — omit to run standalone / local testing)
  const bootstrapList = BOOTSTRAP_PEERS
    ? BOOTSTRAP_PEERS.split(',').map(s => s.trim()).filter(Boolean)
    : []
  if (bootstrapList.length === 0) {
    console.warn('[solver] BOOTSTRAP_PEERS not set — no automatic peer discovery')
  }

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