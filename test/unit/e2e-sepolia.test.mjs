// On-chain + codec checks for Arbitrum Sepolia (no libp2p mesh).
//
// Prereqs: .env with ARB_SEPOLIA_CHAIN_ID=421614, SETTLEMENT_CONTRACT_ADDRESS, etc.
// Run from repo root:
//   source .env && node test/unit/e2e-sepolia.test.mjs
import 'dotenv/config'
import { ethers } from 'ethers'
import { initCodec, encodeIntent, decodeIntent } from '../../sdk/intent-codec.js'
import { computeIntentId } from '../../sdk/intent-id.js'
import { DOMAIN, INTENT_TYPE } from '../../sdk/domain.js'
import { TOPICS } from '../../libp2p/topics.js'

const {
  ARB_SEPOLIA_RPC,
  SOLVER_KEY,
  USER_KEY,
  SETTLEMENT_CONTRACT_ADDRESS,
  REGISTRY_CONTRACT_ADDRESS,
} = process.env

const REQUIRED = { ARB_SEPOLIA_RPC, SOLVER_KEY, USER_KEY }
const missing  = Object.entries(REQUIRED).filter(([, v]) => !v).map(([k]) => k)
if (missing.length) {
  console.error(`Missing env vars: ${missing.join(', ')}`)
  process.exit(1)
}

const TEST_TOKENS = {
  USDC: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
  WETH: '0x980B62Da83eFf3D4576C647993b0c1D7faf17c73',
}

let pass = 0, fail = 0
const ok  = l => { console.log(`  ✓ ${l}`); pass++ }
const bad = l => { console.error(`  ✗ ${l}`); fail++ }

async function run() {
  const provider     = new ethers.JsonRpcProvider(ARB_SEPOLIA_RPC)
  const solverWallet = new ethers.Wallet(SOLVER_KEY, provider)
  const userWallet   = new ethers.Wallet(USER_KEY, provider)
  const network      = await provider.getNetwork()

  console.log(`\nGossamer e2e — Arbitrum Sepolia`)
  console.log(`  chainId:  ${network.chainId}`)
  console.log(`  DOMAIN.chainId (EIP-712): ${DOMAIN.chainId}`)
  if (Number(network.chainId) !== DOMAIN.chainId) {
    console.warn(`  ! RPC chainId ≠ DOMAIN.chainId — set ARB_SEPOLIA_CHAIN_ID in .env to match RPC`)
  }
  console.log(`  solver:   ${solverWallet.address}`)
  console.log(`  user:     ${userWallet.address}`)

  await initCodec()

  console.log('\nNetwork:')
  const block = await provider.getBlockNumber()
  ok(`RPC connected — block ${block}`)

  const solverBal = await provider.getBalance(solverWallet.address)
  const userBal   = await provider.getBalance(userWallet.address)
  ok(`Solver ETH: ${ethers.formatEther(solverBal)} ETH`)
  ok(`User ETH:   ${ethers.formatEther(userBal)} ETH`)

  if (solverBal < ethers.parseEther('0.001')) bad('Solver balance too low for gas')
  else ok('Solver has enough ETH for gas')

  console.log('\nIntent construction:')

  let nonce = '0'
  if (REGISTRY_CONTRACT_ADDRESS?.trim()) {
    const reg = new ethers.Contract(REGISTRY_CONTRACT_ADDRESS.trim(), [
      'function nonces(address) view returns (uint256)',
    ], provider)
    nonce = (await reg.nonces(userWallet.address)).toString()
  }

  const intentData = {
    user:            userWallet.address,
    nonce,
    inputToken:      TEST_TOKENS.USDC,
    outputToken:     TEST_TOKENS.WETH,
    inputAmount:     '1000000',
    minOutputAmount: '400000000000000',
    recipient:       userWallet.address,
    deadline:        Math.floor(Date.now() / 1000) + 600,
    topicTier:       0,
    preferredSolver: ethers.ZeroAddress,
  }

  const signature = await userWallet.signTypedData(DOMAIN, INTENT_TYPE, intentData)
  const intentId  = computeIntentId(intentData)
  const intent    = { ...intentData, intentId, signature }

  ok(`intentId: ${intentId.slice(0, 18)}…`)
  ok(`EIP-712 signed with DOMAIN from sdk/domain.js`)

  console.log('\nCodec:')
  const wireBytes = await encodeIntent(intent)
  const decoded   = await decodeIntent(wireBytes)

  ok(`Encoded: ${wireBytes.length}B`)

  if (decoded.intentId === intent.intentId) ok('intentId survives round-trip')
  else bad('intentId mismatch after codec')

  if (decoded.inputAmount === intent.inputAmount) ok('inputAmount survives (uint256)')
  else bad('inputAmount mismatch')

  const recovered = ethers.verifyTypedData(
    DOMAIN,
    INTENT_TYPE,
    (() => { const { signature: _s, intentId: _id, ...rest } = decoded; return rest })(),
    decoded.signature
  )
  if (recovered.toLowerCase() === userWallet.address.toLowerCase())
    ok('Signature valid after codec round-trip')
  else bad('Signature invalid after codec')

  if (REGISTRY_CONTRACT_ADDRESS?.trim()) {
    console.log('\nRegistry:')
    const reg = new ethers.Contract(REGISTRY_CONTRACT_ADDRESS.trim(), [
      'function isRegistered(address) view returns (bool)',
      'function isActiveAndStaked(address) view returns (bool)',
    ], provider)

    const isRegistered   = await reg.isRegistered(solverWallet.address)
    const isActiveStaked = await reg.isActiveAndStaked(solverWallet.address)

    if (isRegistered) ok(`Solver registered on-chain`)
    else {
      console.warn(`  ! Solver not registered — run (tier 0, ~0.05 ETH):`)
      console.warn(`      PEER_ID=<from run-solver.js> node scripts/register-solver.js`)
    }

    if (isActiveStaked) ok(`Solver stake sufficient`)
    else console.warn(`  ! Solver stake below minimum — top up or re-register`)
  }

  console.log('\nTopics:')
  const expectedTopic = intentData.topicTier === 1 ? TOPICS.TIER1 : TOPICS.PUBLIC
  ok(`Topic: ${expectedTopic}`)

  console.log(`\n${pass + fail} checks — ${pass} passed, ${fail} failed`)

  console.log('\nFull mesh + intent broadcast (separate from this script):')
  console.log('  1. Use an Alchemy/Infura RPC if public Sepolia returns 429.')
  console.log('  2. node scripts/run-solver.js   (note PeerID + multiaddrs)')
  console.log('  3. BOOTSTRAP_PEERS=<solver /ip4/.../ws/p2p/<PeerID> node scripts/run-user.js')
  console.log('  4. Optional: node scripts/settle.js')

  if (fail > 0) process.exit(1)
}

run().catch(e => { console.error(e.message); process.exit(1) })
