// Real solver on Arbitrum Sepolia — GossipSub mesh + solo compute + optional auto-settle.
import 'dotenv/config'
import { ethers } from 'ethers'
import { createSolverNode } from '../node/solver.js'
import { createComputeEngine, PoolStateCache } from '../node/compute-engine.js'
import { attachAuctionCoordinator } from '../node/auction.js'
import { writeFileSync } from 'fs'
import { submitSettlement } from '../node/settlement-submit.js'
import { initCodec } from '../sdk/intent-codec.js'
import { createRatedJsonRpcProvider } from '../node/rpc-provider.js'
import { SolverRegistryABI } from '../ABI/SolverRegistryABI.js'
import { serializeSettlementSnapshot } from '../node/settlement-snapshot.js'

const {
  PRIVATE_KEY,
  ARB_SEPOLIA_RPC,
  SETTLEMENT_CONTRACT_ADDRESS,
  INTENT_SETTLEMENT_ADDRESS,
  REGISTRY_CONTRACT_ADDRESS,
  SOLVER_REGISTRY_ADDRESS,
  BOOTSTRAP_PEERS,
  SOLVER_PORT = '9000',
  SOLVER_TIER = '0',
  AUTO_SETTLE,
} = process.env

const settlementAddress = (
  SETTLEMENT_CONTRACT_ADDRESS?.trim()
  || INTENT_SETTLEMENT_ADDRESS?.trim()
  || ''
)
const registryAddress = (
  REGISTRY_CONTRACT_ADDRESS?.trim()
  || SOLVER_REGISTRY_ADDRESS?.trim()
  || ''
)

if (!PRIVATE_KEY || !ARB_SEPOLIA_RPC) {
  console.error('Required: PRIVATE_KEY, ARB_SEPOLIA_RPC')
  process.exit(1)
}

const WATCHED_POOLS_ARB_SEPOLIA = [
  '0x66EEAB70aC52459Dd74C6AD50D578Ef76a441bbf', // USDC/WETH 0.3%
  '0x6F112d524DC998381C09b4e53C7e5e2cc260f877', // USDC/WETH 0.05%
]

async function main() {
  const chainIdNum = Number(process.env.ARB_SEPOLIA_CHAIN_ID ?? process.env.CHAIN_ID ?? 421614)
  const provider = createRatedJsonRpcProvider(ARB_SEPOLIA_RPC, chainIdNum)
  const wallet  = new ethers.Wallet(PRIVATE_KEY, provider)
  const network = await provider.getNetwork()

  console.log(`[solver] chain: ${network.name} (${network.chainId})`)
  console.log(`[solver] address: ${wallet.address}`)
  console.log(`[solver] balance: ${ethers.formatEther(await provider.getBalance(wallet.address))} ETH`)
  if (settlementAddress) {
    console.log(`[solver] settlement contract: ${settlementAddress}`)
    console.log(`[solver] AUTO_SETTLE: ${AUTO_SETTLE === 'false' ? 'false (winner only)' : 'true → submit settle tx on win'}`)
  } else {
    console.warn('[solver] SETTLEMENT_CONTRACT_ADDRESS unset — EIP-712 DOMAIN may mismatch deploy; settlement disabled')
  }

  await initCodec()

  const poolCache = new PoolStateCache(provider)
  await poolCache.start(WATCHED_POOLS_ARB_SEPOLIA)

  const registryContract = registryAddress
    ? new ethers.Contract(registryAddress, SolverRegistryABI, provider)
    : null

  if (!registryContract) {
    console.warn('[solver] registry contract unset (REGISTRY_CONTRACT_ADDRESS / SOLVER_REGISTRY_ADDRESS) — tier validation skipped')
  }

  const computeSolution = createComputeEngine(wallet, poolCache)

  const bootstrapList = BOOTSTRAP_PEERS
    ? BOOTSTRAP_PEERS.split(',').map(s => s.trim()).filter(Boolean)
    : []
  if (bootstrapList.length === 0) {
    console.warn('[solver] BOOTSTRAP_PEERS unset — outbound discovery idle (users dial this node directly)')
  }

  const node = await createSolverNode({
    port:             Number(SOLVER_PORT),
    tier:             Number(SOLVER_TIER),
    bootstrapList,
    solverPeers:      [],
    registryContract,
    provider,
    computeSolution,
  })

  attachAuctionCoordinator(node, {
    solverPeers: [],
    selfAddress: wallet.address,
    localCompute: computeSolution,
    onWinner: async (bid, intent) => {
      const dumpPath = process.env.DUMP_SETTLEMENT_JSON?.trim()
      if (dumpPath) {
        writeFileSync(
          dumpPath,
          `${JSON.stringify(serializeSettlementSnapshot(intent, bid), null, 2)}\n`,
        )
        console.log(`[auction] settlement snapshot → ${dumpPath}`)
      }

      console.log('[auction] winner selected')
      console.log(`  intentId: ${bid.intentId.slice(0, 18)}…`)
      console.log(`  output:   ${bid.outputAmount}`)

      if (!settlementAddress) {
        console.warn('[auction] no settlement contract in env — stop after off-chain winner')
        return
      }

      if (AUTO_SETTLE === 'false') {
        console.log('[auction] AUTO_SETTLE=false — omitting settle() (run scripts/settle.js manually)')
        return
      }

      try {
        await submitSettlement({
          provider,
          signer: wallet,
          settlementContractAddress: settlementAddress,
          intent,
          bid,
        })
      } catch (e) {
        console.error('[auction] submitSettlement:', e.shortMessage ?? e.message)
      }
    },
  })

  console.log(`\n[solver] ready — ws port ${SOLVER_PORT}`)
  console.log(`[solver] PeerID: ${node.peerId}`)
  console.log('[solver] dial for users BOOTSTRAP_PEERS:')
  node.getMultiaddrs().forEach(a => console.log(`  ${a}`))
  console.log('\n[solver] waiting for intents…\n')

  process.on('SIGINT', async () => {
    console.log('\n[solver] shutting down…')
    poolCache.stop()
    await node.stop()
    process.exit(0)
  })
}

main().catch(e => { console.error(e.message); process.exit(1) })
