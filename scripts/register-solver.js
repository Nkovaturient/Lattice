#!/usr/bin/env node
// scripts/register-solver.js — On-chain SolverRegistry: stake + libp2p PeerID
//
// Safety
// - Use a dedicated hot wallet / funded key only for this network; never commit .env.
// - Verify REGISTRY_CONTRACT_ADDRESS on Arbiscan matches your deployment.
// - PEER_ID must match `node scripts/run-solver.js` output for that wallet.
//   Keys persist in .lattice/libp2p-keys/<evm-address>.key — same wallet → same PeerID.
//
// Tier rules (SolverRegistry.sol)
// - Tier 0 (public mesh): TIER0_MIN_STAKE = 0.05 ETH, no fill history.
// - Tier 1 (trusted topic): TIER1_MIN_STAKE = 0.5 ETH and fills >= MIN_FILLS_TIER1 (10) — cannot register tier 1 on first tx.
//
// Usage — registered tier 0 (default):
//   source .env
//   PEER_ID=12D3KooWJdBPvDuYiCxDxwiQXKqBjmcY8YgRUazArzyJHwgjgJas node scripts/register-solver.js
//
// Worker solvers (uses SOLVER_1_PVT_KEY / SOLVER_2_PVT_KEY from .env):
//   SOLVER_INDEX=1 PEER_ID=<peer from run-solver on :9001> node scripts/register-solver.js
//   SOLVER_INDEX=2 PEER_ID=<peer from run-solver on :9002> node scripts/register-solver.js
//
// Deregister (credits stake, then withdraw() pulls it), then re-register with persisted PeerID:
//   REGISTER_ACTION=peer-id SOLVER_INDEX=1          # print stable PeerID from .lattice/
//   REGISTER_ACTION=deregister SOLVER_INDEX=1       # deregister + withdraw
//   REGISTER_ACTION=withdraw SOLVER_INDEX=1         # retry withdraw only
//   SOLVER_INDEX=1 PEER_ID=<from peer-id cmd> node scripts/register-solver.js
// // Registered tier 0 with above peerId - COORDINATOR PEER_ID - 12D3KooWQRLSb7SQwQKwe62zCjporEH3qVwc1juvpUpJhS7Dj4XS
// /ip4/127.0.0.1/tcp/9000/ws/p2p/12D3KooWJdBPvDuYiCxDxwiQXKqBjmcY8YgRUazArzyJHwgjgJas

// SOLVER_INDEX=1, PEER_ID=12D3KooWMn2kkJivfFSD92wgrTQW4D3ZDSAMXVCMF3Dr6ZSNxEUd
//
// NEW
// 
// Upgrade to tier 1 after you have >= 10 fills on-chain:
//   REGISTER_ACTION=upgrade node scripts/register-solver.js

import 'dotenv/config'
import { ethers } from 'ethers'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import { SolverRegistryABI } from '../ABI/SolverRegistryABI.js'
import { loadOrCreateLibp2pPrivateKey } from '../node/libp2p-key-store.js'

const {
  ARB_SEPOLIA_RPC,
  REGISTRY_CONTRACT_ADDRESS,
  PEER_ID,
  SOLVER_REGISTER_TIER,
  REGISTER_ACTION,
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

if (!PRIVATE_KEY || !ARB_SEPOLIA_RPC || !REGISTRY_CONTRACT_ADDRESS) {
  console.error('Required: PRIVATE_KEY (or SOLVER_INDEX=1|2 + SOLVER_N_PVT_KEY), ARB_SEPOLIA_RPC, REGISTRY_CONTRACT_ADDRESS')
  process.exit(1)
}

let arbiscanBase = 'https://sepolia.arbiscan.io'

async function withdrawPending(registry, address) {
  const pending = await registry.pendingWithdrawals(address)
  if (pending === 0n) {
    console.log('Nothing pending to withdraw.')
    return
  }
  console.log(`Withdrawing ${ethers.formatEther(pending)} ETH…`)
  const tx = await registry.withdraw()
  console.log(`  withdraw tx: ${tx.hash}`)
  console.log(`  arbiscan: ${arbiscanBase}/tx/${tx.hash}`)
  const receipt = await tx.wait()
  console.log(`  confirmed in block ${receipt.blockNumber}`)
}

async function main() {
  const provider = new ethers.JsonRpcProvider(ARB_SEPOLIA_RPC)
  const { chainId } = await provider.getNetwork()
  if (chainId === 42161n) arbiscanBase = 'https://arbiscan.io'
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider)
  const registry = new ethers.Contract(REGISTRY_CONTRACT_ADDRESS, SolverRegistryABI, wallet)

  if (REGISTER_ACTION === 'upgrade') {
    const s = await registry.solvers(wallet.address)
    if (!s.registered) {
      console.error('Not registered — run without REGISTER_ACTION=upgrade first.')
      process.exit(1)
    }
    if (Number(s.tier) === 1) {
      console.log('Already tier 1.')
      process.exit(0)
    }
    const minFills = await registry.MIN_FILLS_TIER1()
    if (s.fills < minFills) {
      console.error(
        `Tier-1 upgrade needs fills >= ${minFills} (yours: ${s.fills}). Complete settlements first.`
      )
      process.exit(1)
    }
    const tier1Min = await registry.TIER1_MIN_STAKE()
    const needed = tier1Min > s.stake ? tier1Min - s.stake : 0n
    console.log(`Upgrading to tier 1 — sending ${ethers.formatEther(needed)} ETH top-up`)
    const tx = await registry.upgradeTier({ value: needed })
    console.log(`  tx: ${tx.hash}`)
    const receipt = await tx.wait()
    console.log(`  confirmed in block ${receipt.blockNumber}`)
    return
  }

  if (REGISTER_ACTION === 'deregister') {
    const s = await registry.solvers(wallet.address)
    if (!s.registered) {
      console.log('Not registered — nothing to deregister.')
      process.exit(0)
    }
    console.log(`Deregistering ${wallet.address}…`)
    console.log(`  on-chain peerId: ${s.peerId}`)
    console.log(`  stake credited:  ${ethers.formatEther(s.stake)} ETH`)
    const tx = await registry.deregister()
    console.log(`  deregister tx: ${tx.hash}`)
    console.log(`  arbiscan: ${arbiscanBase}/tx/${tx.hash}`)
    const receipt = await tx.wait()
    console.log(`  confirmed in block ${receipt.blockNumber}`)
    await withdrawPending(registry, wallet.address)
    console.log('\nNext: REGISTER_ACTION=peer-id SOLVER_INDEX=N  then register with that PEER_ID.')
    return
  }

  if (REGISTER_ACTION === 'withdraw') {
    await withdrawPending(registry, wallet.address)
    return
  }

  if (REGISTER_ACTION === 'peer-id') {
    const privateKey = await loadOrCreateLibp2pPrivateKey(wallet.address)
    const peerId = peerIdFromPrivateKey(privateKey).toString()
    console.log(`address: ${wallet.address}`)
    console.log(`PeerID:  ${peerId}`)
    console.log(`\nRegister:\n  SOLVER_INDEX=${process.env.SOLVER_INDEX ?? ''} PEER_ID=${peerId} node scripts/register-solver.js`)
    return
  }

  if (!PEER_ID?.trim()) {
    console.error('Required: PEER_ID (libp2p PeerID from `node scripts/run-solver.js`)')
    process.exit(1)
  }

  const peerId = PEER_ID.trim()

  const already = await registry.isRegistered(wallet.address)
  if (already) {
    const stake = await registry.stake(wallet.address)
    const tier = await registry.solverTier(wallet.address)
    console.log(`Already registered — tier ${tier}, stake ${ethers.formatEther(stake)} ETH`)
    console.log('To re-register with a new PeerID: REGISTER_ACTION=deregister first.')
    console.log('To move to tier 1 after enough fills: REGISTER_ACTION=upgrade node scripts/register-solver.js')
    process.exit(0)
  }

  const tier = Math.min(1, Math.max(0, Number(SOLVER_REGISTER_TIER ?? 0)))
  const tier0Min = await registry.TIER0_MIN_STAKE()
  const tier1Min = await registry.TIER1_MIN_STAKE()
  const minFills = await registry.MIN_FILLS_TIER1()

  let stakeAmt
  if (tier === 1) {
    const s = await registry.solvers(wallet.address)
    if (s.fills < minFills) {
      console.error(
        `Cannot register as tier 1 without fill history (need fills >= ${minFills}, yours: ${s.fills}).\n` +
        `Register tier 0 first: unset SOLVER_REGISTER_TIER or set SOLVER_REGISTER_TIER=0`
      )
      process.exit(1)
    }
    stakeAmt = tier1Min
  } else {
    stakeAmt = tier0Min
  }

  console.log(`Registering solver (tier ${tier})…`)
  console.log(`  address:  ${wallet.address}`)
  console.log(`  peerId:   ${peerId}`)
  console.log(`  stake:    ${ethers.formatEther(stakeAmt)} ETH`)

  const tx = await registry.register(peerId, tier, { value: stakeAmt })
  console.log(`  tx: ${tx.hash}`)
  console.log(`  arbiscan: ${arbiscanBase}/tx/${tx.hash}`)

  const receipt = await tx.wait()
  console.log(`  confirmed in block ${receipt.blockNumber}`)
  if (tier === 0) {
    console.log(
      '\nNext: run `node scripts/run-solver.js` with SOLVER_TIER=0 for public topic, or after 10+ fills run REGISTER_ACTION=upgrade then SOLVER_TIER=1.'
    )
  } else {
    console.log('\nRegistered tier 1. Run `node scripts/run-solver.js` with SOLVER_TIER=1.')
  }
}

main().catch(e => { console.error(e.message); process.exit(1) })


/*
# 1) Show stable PeerID (from .lattice/libp2p-keys/)
REGISTER_ACTION=peer-id SOLVER_INDEX=1 node scripts/register-solver.js
REGISTER_ACTION=peer-id SOLVER_INDEX=2 node scripts/register-solver.js

# 2) Deregister old registration (returns 0.05 ETH)
REGISTER_ACTION=deregister SOLVER_INDEX=1 node scripts/register-solver.js
REGISTER_ACTION=deregister SOLVER_INDEX=2 node scripts/register-solver.js

# 3) Register with NEW PeerID from step 1
SOLVER_INDEX=1 PEER_ID=12D3KooWHGTqLNq8mRqev6Z3hNqzawjHmRek3jx4v4K9zGEH6PwB node scripts/register-solver.js

Registering solver (tier 0)…
  address:  0x9D48b65Bb45f144CBC5662Fd3Fd011659371D0f8
  peerId:   12D3KooWHGTqLNq8mRqev6Z3hNqzawjHmRek3jx4v4K9zGEH6PwB
  stake:    0.05 ETH
  tx: 0xabea666d5106009261ded2d391e68ec4951f2abd3ae35c0c6def1cb218792855
  arbiscan: https://sepolia.arbiscan.io/tx/0xabea666d5106009261ded2d391e68ec4951f2abd3ae35c0c6def1cb218792855
  confirmed in block 270784419

  */

/*
==============================
SOLVER_INDEX=2 PEER_ID=12D3KooWBFYvVweEp7miyXPFHoUD4pjqf6CFHQLHTdBXTJdfxhcN node scripts/register-solver.js

Registering solver (tier 0)…
address:  0xbbB6F72686D2a3f7Bc89761600d4CBA102855475
peerId:   12D3KooWBFYvVweEp7miyXPFHoUD4pjqf6CFHQLHTdBXTJdfxhcN
stake:    0.05 ETH
tx: 0xa486b34513ca332ff3f4ebce72731ae1e7adbced57d256ff237a13a1c90cc324
arbiscan: https://sepolia.arbiscan.io/tx/0xa486b34513ca332ff3f4ebce72731ae1e7adbced57d256ff237a13a1c90cc324
confirmed in block 270784475




COORDINATOR -- 
address: 0x1Bf95a7322D3B207A5a6f1beed9dD2C8145558fC
PeerID:  12D3KooWEtsL42U9m9j5Zg2Xvj1N2ihr8MP2uwaX982tf2QoS4fE



# 1) Workers first (T1, T2)
SOLVER_INDEX=1 SOLVER_PORT=9001 AUCTION_ROLE=worker \
BOOTSTRAP_PEERS=/ip4/127.0.0.1/tcp/9000/ws/p2p/12D3KooWEtsL42U9m9j5Zg2Xvj1N2ihr8MP2uwaX982tf2QoS4fE \
node scripts/run-solver.js

SOLVER_INDEX=2 SOLVER_PORT=9002 AUCTION_ROLE=worker \
BOOTSTRAP_PEERS=/ip4/127.0.0.1/tcp/9000/ws/p2p/12D3KooWEtsL42U9m9j5Zg2Xvj1N2ihr8MP2uwaX982tf2QoS4fE \
node scripts/run-solver.js

# 2) Coordinator (T0) — restart if already running
PRIVATE_KEY=$PRIVATE_KEY \
SOLVER_PEER_ADDRS=/ip4/127.0.0.1/tcp/9001/ws/p2p/12D3KooWHGTqLNq8mRqev6Z3hNqzawjHmRek3jx4v4K9zGEH6PwB,/ip4/127.0.0.1/tcp/9002/ws/p2p/12D3KooWBFYvVweEp7miyXPFHoUD4pjqf6CFHQLHTdBXTJdfxhcN \
node scripts/run-solver.js

=== Expect on coordinator: worker peer connected: ×2 (on connect or within ~30s).

# 3) User
BOOTSTRAP_PEERS=/ip4/127.0.0.1/tcp/9000/ws/p2p/12D3KooWEtsL42U9m9j5Zg2Xvj1N2ihr8MP2uwaX982tf2QoS4fE \
node scripts/run-user.js

*/
