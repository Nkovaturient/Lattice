#!/usr/bin/env node
// scripts/register-solver.js — On-chain SolverRegistry: stake + libp2p PeerID
//
// Safety
// - Use a dedicated hot wallet / funded key only for this network; never commit .env.
// - Verify REGISTRY_CONTRACT_ADDRESS on Arbiscan matches your deployment.
// - PEER_ID must match the solver shown when you run `node scripts/run-solver.js` (new key → new PeerID).
//
// Tier rules (SolverRegistry.sol)
// - Tier 0 (public mesh): TIER0_MIN_STAKE = 0.05 ETH, no fill history.
// - Tier 1 (trusted topic): TIER1_MIN_STAKE = 0.5 ETH and fills >= MIN_FILLS_TIER1 (10) — cannot register tier 1 on first tx.
//
// Usage — registered tier 0 (default):
//   source .env
//   PEER_ID=12D3KooWJdBPvDuYiCxDxwiQXKqBjmcY8YgRUazArzyJHwgjgJas node scripts/register-solver.js
// Registered tier 0 with above peerId
// /ip4/127.0.0.1/tcp/9000/ws/p2p/12D3KooWJdBPvDuYiCxDxwiQXKqBjmcY8YgRUazArzyJHwgjgJas
//
// Upgrade to tier 1 after you have >= 10 fills on-chain:
//   REGISTER_ACTION=upgrade node scripts/register-solver.js

import 'dotenv/config'
import { ethers } from 'ethers'
import { SolverRegistryABI } from '../ABI/SolverRegistryABI.js'

const {
  PRIVATE_KEY,
  ARB_SEPOLIA_RPC,
  REGISTRY_CONTRACT_ADDRESS,
  PEER_ID,
  SOLVER_REGISTER_TIER,
  REGISTER_ACTION,
} = process.env

if (!PRIVATE_KEY || !ARB_SEPOLIA_RPC || !REGISTRY_CONTRACT_ADDRESS) {
  console.error('Required: PRIVATE_KEY, ARB_SEPOLIA_RPC, REGISTRY_CONTRACT_ADDRESS')
  process.exit(1)
}

// const REGISTRY_ABI = [
//   'function register(string peerId, uint8 tier) payable',
//   'function upgradeTier() payable',
//   'function isRegistered(address) view returns (bool)',
//   'function stake(address) view returns (uint256)',
//   'function solverTier(address) view returns (uint8)',
//   'function solvers(address) view returns (bool registered, uint8 tier, uint256 stake, uint256 fills, uint256 slashes, string peerId)',
//   'function MIN_STAKE() view returns (uint256)',
//   'function TIER0_MIN_STAKE() view returns (uint256)',
//   'function TIER1_MIN_STAKE() view returns (uint256)',
//   'function MIN_FILLS_TIER1() view returns (uint256)',
//   'event SolverRegistered(address indexed solver, string peerId, uint8 tier)',
// ]

async function main() {
  const provider = new ethers.JsonRpcProvider(ARB_SEPOLIA_RPC)
  const wallet   = new ethers.Wallet(PRIVATE_KEY, provider)
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
    const needed   = tier1Min > s.stake ? tier1Min - s.stake : 0n
    console.log(`Upgrading to tier 1 — sending ${ethers.formatEther(needed)} ETH top-up`)
    const tx = await registry.upgradeTier({ value: needed })
    console.log(`  tx: ${tx.hash}`)
    const receipt = await tx.wait()
    console.log(`  confirmed in block ${receipt.blockNumber}`)
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
    const tier  = await registry.solverTier(wallet.address)
    console.log(`Already registered — tier ${tier}, stake ${ethers.formatEther(stake)} ETH`)
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
  console.log(`  arbiscan: https://sepolia.arbiscan.io/tx/${tx.hash}`)

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
