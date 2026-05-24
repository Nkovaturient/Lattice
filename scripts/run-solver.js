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
import { attachMeshMonitor, logMeshMetrics } from '../node/mesh-monitor.js'
import { registerSettleWinHandler, requestRemoteSettle } from '../libp2p/settle-notify.js'

const {
  ARB_SEPOLIA_RPC,
  SETTLEMENT_CONTRACT_ADDRESS,
  INTENT_SETTLEMENT_ADDRESS,
  REGISTRY_CONTRACT_ADDRESS,
  SOLVER_REGISTRY_ADDRESS,
  BOOTSTRAP_PEERS,
  SOLVER_PORT = '9000',
  SOLVER_TIER = '0',
  AUTO_SETTLE,
  SOLVER_PEERS,
  SOLVER_PEER_ADDRS,
  AUCTION_ROLE = 'coordinator',
} = process.env

function normalizeHexKey(key) {
  const k = key.trim()
  if (/^[Oo]x/i.test(k)) return `0x${k.slice(2)}`
  return k
}

function resolvePrivateKey() {
  const idx = process.env.SOLVER_INDEX?.trim()
  if (idx === '1' && process.env.SOLVER_1_PVT_KEY) return normalizeHexKey(process.env.SOLVER_1_PVT_KEY)
  if (idx === '2' && process.env.SOLVER_2_PVT_KEY) return normalizeHexKey(process.env.SOLVER_2_PVT_KEY)
  if (idx === '3' && process.env.SOLVER_3_PVT_KEY) return normalizeHexKey(process.env.SOLVER_3_PVT_KEY)
  if (process.env.SOLVER_PVT_KEY) return normalizeHexKey(process.env.SOLVER_PVT_KEY)
  if (process.env.PRIVATE_KEY) return normalizeHexKey(process.env.PRIVATE_KEY)
  return null
}

const PRIVATE_KEY = resolvePrivateKey()

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
  console.error('Required: PRIVATE_KEY (or SOLVER_INDEX + SOLVER_N_PVT_KEY), ARB_SEPOLIA_RPC')
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

  const computeSolution = createComputeEngine(wallet, poolCache, provider)

  const bootstrapList = BOOTSTRAP_PEERS
    ? BOOTSTRAP_PEERS.split(',').map(s => s.trim()).filter(Boolean)
    : []
  if (bootstrapList.length === 0 && AUCTION_ROLE !== 'coordinator') {
    console.warn('[solver] BOOTSTRAP_PEERS unset — outbound discovery idle (users dial this node directly)')
  }

  const { peerIdFromString } = await import('@libp2p/peer-id')
  const { multiaddr } = await import('@multiformats/multiaddr')

  const solverPeerAddrList = SOLVER_PEER_ADDRS
    ? SOLVER_PEER_ADDRS.split(',').map(s => s.trim()).filter(Boolean)
    : []

  const solverPeerIdsFromAddrs = solverPeerAddrList.map(addr => {
    const p2p = multiaddr(addr).getComponents().find(c => c.name === 'p2p')
    if (!p2p?.value) throw new Error(`SOLVER_PEER_ADDRS entry missing /p2p/ PeerID: ${addr}`)
    return peerIdFromString(p2p.value)
  })

  const solverPeerIds = SOLVER_PEERS
    ? SOLVER_PEERS.split(',').map(s => s.trim()).filter(Boolean).map(peerIdFromString)
    : solverPeerIdsFromAddrs

  const solverPeerAddrs = solverPeerAddrList.map(addr => ({ multiaddr: addr }))

  const isWorker = AUCTION_ROLE === 'worker'

  const node = await createSolverNode({
    port:             Number(SOLVER_PORT),
    tier:             Number(SOLVER_TIER),
    bootstrapList,
    solverPeers:      solverPeerAddrs,
    registryContract,
    provider,
    computeSolution,
    rfqCommitReveal:  isWorker || solverPeerIds.length > 0,
    evmAddress:       wallet.address,
  })

  let solverPeerByAddress = new Map()
  if (!isWorker && registryContract && solverPeerAddrList.length > 0) {
    solverPeerByAddress = await buildSolverPeerByAddress(
      registryContract,
      solverPeerAddrList,
      multiaddr,
      peerIdFromString,
    )
  }

  if (isWorker && settlementAddress) {
    registerSettleWinHandler(node, async ({ intent, bid }) => {
      const winner = ethers.getAddress(bid.solver)
      if (winner.toLowerCase() !== wallet.address.toLowerCase()) {
        console.warn(`[settle-win] ignored — bid.solver ${winner} ≠ this worker`)
        return
      }
      if (AUTO_SETTLE === 'false') {
        console.log('[settle-win] AUTO_SETTLE=false — omitting settle()')
        return
      }
      console.log('[settle-win] auction won — submitting settle()')
      await submitSettlement({
        provider,
        signer: wallet,
        settlementContractAddress: settlementAddress,
        intent,
        bid,
      })
    })
    console.log('[solver] settle-win handler registered')
  }

  const attachAuction = !isWorker

  if (attachAuction) {
  attachAuctionCoordinator(node, {
    solverPeers: solverPeerIds,
    selfAddress: wallet.address,
    localCompute: solverPeerIds.length === 0 ? computeSolution : undefined,
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

      const winner = ethers.getAddress(bid.solver)
      const isLocalWinner = winner.toLowerCase() === wallet.address.toLowerCase()

      try {
        if (isLocalWinner) {
          await submitSettlement({
            provider,
            signer: wallet,
            settlementContractAddress: settlementAddress,
            intent,
            bid,
          })
          return
        }

        const winnerPeer = solverPeerByAddress.get(winner.toLowerCase())
        if (!winnerPeer) {
          console.warn(
            `[auction] remote winner ${winner} — no PeerID map entry; ` +
              'settle manually with winner key + settlement-pair.json'
          )
          return
        }

        console.log(`[auction] remote winner ${winner.slice(0, 10)}… — notifying worker to settle`)
        await requestRemoteSettle(node, winnerPeer, intent, bid)
        console.log('[auction] remote settle complete')
      } catch (e) {
        console.error('[auction] submitSettlement:', e.shortMessage ?? e.message)
      }
    },
  })
  } else {
    console.log('[solver] AUCTION_ROLE=worker — RFQ only (no gossip auction / auto-settle)')
  }

  attachMeshMonitor(node, [])

  console.log(`\n[solver] ready — ws port ${SOLVER_PORT} (${isWorker ? 'worker' : 'coordinator'})`)
  console.log(`[solver] PeerID: ${node.peerId}`)
  if (solverPeerIds.length > 0) {
    console.log(`[solver] remote solvers: ${solverPeerIds.map(p => p.toString()).join(', ')}`)
  }
  console.log('[solver] dial for users BOOTSTRAP_PEERS:')
  node.getMultiaddrs().forEach(a => console.log(`  ${a}`))
  console.log('\n[solver] waiting for intents…\n')

  if (!isWorker && solverPeerIds.length > 0) {
    watchSolverPeers(node, solverPeerIds)
    verifySolverPeers(node, solverPeerIds).catch(() => {})
  }

  setInterval(() => logMeshMetrics(node, []), 60_000).unref?.()

  process.on('SIGINT', async () => {
    console.log('\n[solver] shutting down…')
    poolCache.stop()
    await node.stop()
    process.exit(0)
  })
}

main().catch(e => { console.error(e.message); process.exit(1) })

async function verifySolverPeers(node, solverPeerIds) {
  const expected = solverPeerIds.map(p => p.toString())
  const deadline = Date.now() + 30_000

  while (Date.now() < deadline) {
    const connected = new Set(node.getPeers().map(p => p.toString()))
    const missing = expected.filter(id => !connected.has(id))
    if (missing.length === 0) return
    await new Promise(r => setTimeout(r, 2_000))
  }

  const connected = new Set(node.getPeers().map(p => p.toString()))
  for (const id of expected) {
    if (connected.has(id)) {
      console.log(`[solver] worker peer connected: ${id}`)
      continue
    }
    console.warn(
      `[solver] ⚠ worker ${id.slice(0, 12)}… NOT connected — RFQ will fail for this solver.\n` +
        '         Ensure worker is running (check EADDRINUSE on :9001/:9002).\n' +
        '         Start workers before coordinator, or wait for retry.'
    )
  }
}

function watchSolverPeers(node, solverPeerIds) {
  const expected = new Set(solverPeerIds.map(p => p.toString()))
  node.addEventListener('peer:connect', (evt) => {
    const id = evt.detail.toString()
    if (expected.has(id)) {
      console.log(`[solver] worker peer connected: ${id}`)
    }
  })
}

async function buildSolverPeerByAddress(registry, addrList, multiaddrFn, peerIdFromStringFn) {
  const map = new Map()
  for (const addr of addrList) {
    const p2p = multiaddrFn(addr).getComponents().find(c => c.name === 'p2p')?.value
    if (!p2p) continue
    const evm = await registry.peerIdToAddress(p2p)
    if (!evm || evm === ethers.ZeroAddress) continue
    map.set(ethers.getAddress(evm).toLowerCase(), peerIdFromStringFn(p2p))
  }
  return map
}
