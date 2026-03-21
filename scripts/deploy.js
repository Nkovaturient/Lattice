#!/usr/bin/env node
// Gossamer deployment script — Sepolia testnet
// Deploy order: SolverRegistry → IntentSettlement
// Run: PRIVATE_KEY=0x... RPC_URL=https://... node scripts/deploy.js

/**  ORDER ORDER 
# 3. Build + test locally
forge build
forge test -vvv

# 4. Fork test (real Uniswap pools, no real funds)
anvil --fork-url $ARB_MAINNET_RPC
forge script script/Deploy.s.sol --rpc-url anvil --broadcast

# 5. Deploy to Arbitrum Sepolia
forge script script/Deploy.s.sol --rpc-url $ARB_SEPOLIA_RPC --broadcast --verify

# 6. Register solver
node scripts/register-solver.js

# 7. Run the mesh
node scripts/run-solver.js  # terminal 1
node scripts/run-user.js    # terminal 2
node scripts/settle.js      # terminal 3 (after auction fires)

**/

import { ethers } from 'ethers'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dir = dirname(fileURLToPath(import.meta.url))

// ── Minimal inline bytecode stubs ────────────────────────────────────────────
// In a real project: npx hardhat compile → artifacts/
// Here we demonstrate the deployment wiring — swap in real bytecode
// from `npx hardhat compile` before using on real networks.

const PLACEHOLDER_BYTECODE = '0x60806040526000805534801561001457600080fd5b50'

function loadABI(name) {
  // In real project: import from artifacts/contracts/NAME.sol/NAME.json
  // Here: derive from our contract source via solc or hardhat
  console.log(`  [abi] loading ${name} — integrate with hardhat artifacts in production`)
  return []
}

// ── Deploy ────────────────────────────────────────────────────────────────────

async function main() {
  const rpcUrl    = process.env.RPC_URL
  const privateKey = process.env.PRIVATE_KEY

  if (!rpcUrl || !privateKey) {
    console.error('Missing RPC_URL or PRIVATE_KEY env vars')
    console.error('Usage: RPC_URL=https://sepolia.infura.io/v3/KEY PRIVATE_KEY=0x... node scripts/deploy.js')
    process.exit(1)
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl)
  const deployer = new ethers.Wallet(privateKey, provider)
  const network  = await provider.getNetwork()

  console.log('\nGossamer deployment')
  console.log(`  network : ${network.name} (chainId ${network.chainId})`)
  console.log(`  deployer: ${deployer.address}`)

  const balance = await provider.getBalance(deployer.address)
  console.log(`  balance : ${ethers.formatEther(balance)} ETH`)

  if (balance < ethers.parseEther('0.05')) {
    console.warn('  warn: low balance — may run out of gas')
  }

  // ── 1. Deploy SolverRegistry (needs settlement address — use zero for now) ─
  console.log('\n[1/2] Deploying SolverRegistry...')
  // In production with hardhat:
  //   const Registry = await ethers.getContractFactory('SolverRegistry')
  //   const registry = await Registry.deploy(SETTLEMENT_ADDRESS)
  //   await registry.waitForDeployment()
  console.log('  → compile with: npx hardhat compile')
  console.log('  → deploy with:  npx hardhat run scripts/deploy.js --network sepolia')

  // ── 2. Deploy IntentSettlement ─────────────────────────────────────────────
  console.log('\n[2/2] Deploying IntentSettlement...')
  console.log('  → constructor arg: SolverRegistry address')

  // ── 3. Wire SolverRegistry → IntentSettlement ──────────────────────────────
  // SolverRegistry.settlementContract is immutable — redeploy if changed
  console.log('\n[3] Update .env.example with deployed addresses:')
  console.log('  SETTLEMENT_CONTRACT_ADDRESS=0x...')
  console.log('  REGISTRY_CONTRACT_ADDRESS=0x...')

  // ── Sepolia SwapRouter (Uniswap v3) ────────────────────────────────────────
  const SWAP_ROUTER_SEPOLIA = '0xE592427A0AEce92De3Edee1F18E0157C05861564'
  console.log(`\n  Uniswap v3 SwapRouter on ${network.name}: ${SWAP_ROUTER_SEPOLIA}`)
  console.log('  (same address as mainnet — Uniswap deploys to same address cross-chain)')
}

main().catch(e => { console.error(e.message); process.exit(1) })