#!/usr/bin/env node
// scripts/register-solver.js — Register solver on-chain with stake
// Run once before starting the solver node.
// Usage: PRIVATE_KEY=0x... ARB_SEPOLIA_RPC=https://... \
//        REGISTRY_CONTRACT_ADDRESS=0x... PEER_ID=12D3KooW... \
//        node scripts/register-solver.js

import { ethers } from 'ethers'

const { PRIVATE_KEY, ARB_SEPOLIA_RPC, REGISTRY_CONTRACT_ADDRESS, PEER_ID } = process.env

if (!PRIVATE_KEY || !ARB_SEPOLIA_RPC || !REGISTRY_CONTRACT_ADDRESS || !PEER_ID) {
  console.error('Required: PRIVATE_KEY, ARB_SEPOLIA_RPC, REGISTRY_CONTRACT_ADDRESS, PEER_ID')
  console.error('Get your PEER_ID by running: node scripts/run-solver.js (prints on startup)')
  process.exit(1)
}

const REGISTRY_ABI = [
  'function register(string peerId, uint8 tier) payable',
  'function isRegistered(address) view returns (bool)',
  'function stake(address) view returns (uint256)',
  'function MIN_STAKE() view returns (uint256)',
  'event SolverRegistered(address indexed solver, string peerId, uint8 tier)',
]

async function main() {
  const provider = new ethers.JsonRpcProvider(ARB_SEPOLIA_RPC)
  const wallet   = new ethers.Wallet(PRIVATE_KEY, provider)
  const registry = new ethers.Contract(REGISTRY_CONTRACT_ADDRESS, REGISTRY_ABI, wallet)

  const already = await registry.isRegistered(wallet.address)
  if (already) {
    const stake = await registry.stake(wallet.address)
    console.log(`Already registered. Stake: ${ethers.formatEther(stake)} ETH`)
    process.exit(0)
  }

  const minStake = await registry.MIN_STAKE()
  const stakeAmt = minStake  // register with exactly MIN_STAKE (0.1 ETH)

  console.log(`Registering solver...`)
  console.log(`  address:  ${wallet.address}`)
  console.log(`  peerId:   ${PEER_ID}`)
  console.log(`  stake:    ${ethers.formatEther(stakeAmt)} ETH`)

  const tx = await registry.register(PEER_ID, 1, { value: stakeAmt })
  console.log(`  tx: ${tx.hash}`)
  console.log(`  arbiscan: https://sepolia.arbiscan.io/tx/${tx.hash}`)

  const receipt = await tx.wait()
  console.log(`  confirmed in block ${receipt.blockNumber}`)
  console.log(`\nSolver registered. You can now run: node scripts/run-solver.js`)
}

main().catch(e => { console.error(e.message); process.exit(1) })