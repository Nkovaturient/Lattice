import { ethers } from 'ethers'
import { IntentSettlementABI } from '../ABI/IntentSettlementABI.js'
import { SolverRegistryABI } from '../ABI/SolverRegistryABI.js'
import { MockERC20ABI } from '../ABI/MockERC20ABI.js'
import { withRpcRetries } from './rpc-provider.js'

export class SettlementPreflightError extends Error {
  /**
   * @param {string} step e.g. "L111 — Solver not registered"
   * @param {string} contractMessage matches require() revert string where applicable
   * @param {string} [fix]
   */
  constructor(step, contractMessage, fix) {
    const tail = fix ? ` Fix: ${fix}` : ''
    super(`[preflight:${step}] ${contractMessage}.${tail}`)
    this.step = step
    this.contractMessage = contractMessage
    this.fix = fix
    this.name = 'SettlementPreflightError'
  }
}

function bytes32Compat(x) {
  if (typeof x === 'string' && x.startsWith('0x') && x.length === 66)
    return x
  return ethers.hexlify(x)
}

function routeToHex(route) {
  if (route instanceof Uint8Array) return ethers.hexlify(route)
  if (typeof route === 'string' && route.startsWith('0x')) return route
  return ethers.hexlify(route)
}

function u256(v) {
  return BigInt(typeof v === 'bigint' ? v : v?.toString?.() ?? `${v}`)
}

/**
 * Build `settle` args exactly as ethers encodes them for IntentSettlementABI.
 *
 * @returns {[unknown[], string, unknown[], string]} intentTuple,sig,bidTuple,bidSig
 */
export function buildSettleArgs(intent, bid) {
  const intentSig = intent.signature ?? intent.intentSig
  const bidSig = bid.signature
  if (!intentSig || !bidSig)
    throw new Error(
      'buildSettleArgs: intent.signature / intentSig and bid.signature required'
    )

  const intentIdHex = bytes32Compat(bid.intentId)
  const bidRouteHex = routeToHex(bid.route ?? bid.encodedRoute)
  const bidDeadline = bid.deadline ?? intent.deadline

  const intentTuple = [
    ethers.getAddress(intent.user),
    u256(intent.nonce),
    ethers.getAddress(intent.inputToken),
    ethers.getAddress(intent.outputToken),
    u256(intent.inputAmount),
    u256(intent.minOutputAmount),
    ethers.getAddress(intent.recipient),
    Number(intent.deadline),
    Number(intent.topicTier),
    ethers.getAddress(intent.preferredSolver ?? ethers.ZeroAddress),
  ]

  const bidTuple = [
    intentIdHex,
    ethers.getAddress(bid.solver),
    u256(bid.outputAmount),
    bidRouteHex,
    Number(bidDeadline),
  ]

  return [intentTuple, intentSig, bidTuple, bidSig]
}

/**
 * On-chain checks in the same order as IntentSettlement.sol `settle` requires.
 * Throws {@link SettlementPreflightError} on the first violated condition that
 * the contract tests before executing the swap (through tier checks inclusive).
 *
 * Optionally validates ERC‑20 balance/allowance (needed before transferFrom —
 * runs after Solidity requires L123–128 but surfaced as layered checks).
 *
 * @param {object} p
 * @param {ethers.Provider} p.provider
 * @param {string} p.settlementAddress
 * @param {string} p.solverAddress `msg.sender` for settle — must equal bid.solver
 * @param {object} p.intent
 * @param {object} p.bid
 * @param {boolean} [p.skipErc20] skip balance/allowance (default false)
 */
export async function assertSettlementPreflight({
  provider,
  settlementAddress,
  solverAddress,
  intent,
  bid,
  skipErc20 = false,
}) {
  const solver = ethers.getAddress(solverAddress)
  const settlement = new ethers.Contract(
    settlementAddress,
    IntentSettlementABI,
    provider
  )

  let registryAddr
  try {
    registryAddr = await withRpcRetries(() => settlement.registry())
  } catch {
    throw new SettlementPreflightError(
      'registry',
      'Could not read settlement.registry()',
      'Ensure SETTLEMENT_CONTRACT_ADDRESS matches the deployed IntentSettlement.'
    )
  }

  const registry = new ethers.Contract(registryAddr, SolverRegistryABI, provider)
  const settleArgs = buildSettleArgs(intent, bid)
  const [, intentSig, bidTuple] = settleArgs

  const { DOMAIN, INTENT_TYPE, BID_TYPE } = await import('../sdk/domain.js')

  let intentDigest
  try {
    intentDigest = ethers.TypedDataEncoder.hash(DOMAIN, INTENT_TYPE, {
      user:            ethers.getAddress(intent.user),
      nonce:           u256(intent.nonce),
      inputToken:      ethers.getAddress(intent.inputToken),
      outputToken:     ethers.getAddress(intent.outputToken),
      inputAmount:     u256(intent.inputAmount),
      minOutputAmount: u256(intent.minOutputAmount),
      recipient:       ethers.getAddress(intent.recipient),
      deadline:        u256(intent.deadline),
      topicTier:       BigInt(intent.topicTier),
      preferredSolver: ethers.getAddress(
        intent.preferredSolver ?? ethers.ZeroAddress
      ),
    })
  } catch (e) {
    throw new SettlementPreflightError(
      'L100',
      `Could not compute intent EIP-712 digest: ${e.message}`,
      'Check intent fields against domain.js INTENT_TYPE.'
    )
  }

  const intentIdComputed =
    intentDigest.startsWith('0x') && intentDigest.length === 66
      ? intentDigest
      : ethers.hexlify(intentDigest)

  const bidRouteHex = bidTuple[3]
  const bidDeadline = BigInt(bidTuple[4])

  // L103 — Intent already settled (intentIdComputed matches contract’s _domainHash)
  const settledFlag = await withRpcRetries(() =>
    settlement.settled(intentIdComputed)
  )
  if (settledFlag)
    throw new SettlementPreflightError(
      'L103',
      'Intent already settled',
      'This intentId was already replayed — build a fresh intent or use a fresh nonce.'
    )

  const now = Math.floor(Date.now() / 1000)

  if (now > Number(intent.deadline))
    throw new SettlementPreflightError(
      'L104',
      'Intent expired',
      'Rebuild intent with a longer deadline (run-user) before broadcasting.'
    )

  if (now > Number(bidDeadline))
    throw new SettlementPreflightError(
      'L105',
      'Bid expired',
      'Produce a fresher bid.signature with bid.deadline in the future.'
    )

  if (Number(bidDeadline) > Number(intent.deadline))
    throw new SettlementPreflightError(
      'L106',
      'Bid extends past intent',
      'Ensure bid.deadline <= intent.deadline.'
    )

  const inTok = ethers.getAddress(intent.inputToken)
  const outTok = ethers.getAddress(intent.outputToken)
  if (
    inTok === ethers.ZeroAddress ||
    outTok === ethers.ZeroAddress
  )
    throw new SettlementPreflightError(
      'L108',
      'ERC20 only',
      'Use wrapped native or an ERC‑20 pair; IntentSettlement rejects address(0) tokens.'
    )

  const active = await withRpcRetries(() =>
    registry.isActiveAndStaked(solver)
  )
  if (!active)
    throw new SettlementPreflightError(
      'L110',
      'Solver not registered',
      `Call registry helpers / register-solver so isActiveAndStaked(${solver.slice(0, 10)}…) is true (registered + tier min stake).`
    )

  const intentSigOk =
    ethers.recoverAddress(intentDigest, intentSig).toLowerCase() ===
    ethers.getAddress(intent.user).toLowerCase()
  if (!intentSigOk)
    throw new SettlementPreflightError(
      'L112',
      'Invalid intent signature',
      `Re-sign intent with the user's key; EIP-712 domain must match CHAIN_ID and INTENT_SETTLEMENT_ADDRESS (${settlementAddress.slice(0, 10)}…).`
    )

  const nonceOnChain = await withRpcRetries(() =>
    registry.nonces(ethers.getAddress(intent.user))
  )
  const intentNonce = u256(intent.nonce)
  if (nonceOnChain !== intentNonce)
    throw new SettlementPreflightError(
      'L114',
      `Nonce mismatch (registry: ${nonceOnChain}, intent: ${intentNonce})`,
      'Re-sign intent after reading SolverRegistry.nonces(user) — nonce lives on registry, not on settlement.'
    )

  try {
    const recoveredBid = ethers.verifyTypedData(DOMAIN, BID_TYPE, {
      intentId:     ethers.hexlify(bytes32Compat(bid.intentId)),
      solver:       ethers.getAddress(bid.solver),
      outputAmount: u256(bid.outputAmount),
      route:        bidRouteHex,
      deadline:     bidDeadline,
    }, bid.signature)
    if (recoveredBid.toLowerCase() !== solver.toLowerCase())
      throw new SettlementPreflightError(
        'L117',
        'Invalid bid signature',
        `Recovered signer ${recoveredBid.slice(0, 14)}… !== msg.sender / bid.solver ${solver.slice(0, 14)}…`
      )
  } catch (e) {
    if (e instanceof SettlementPreflightError) throw e
    throw new SettlementPreflightError(
      'L117',
      `Invalid bid signature (${e.shortMessage ?? e.message})`,
      'Re-sign the bid tuple with the solver private key.'
    )
  }

  const bidIntentIdHex = ethers.hexlify(bytes32Compat(bid.intentId))
  if (bidIntentIdHex !== intentIdComputed)
    throw new SettlementPreflightError(
      'L119',
      'Bid intentId mismatch',
      'bid.intentId must equal the EIP-712 intent digest for these intent fields.'
    )

  if (ethers.getAddress(bid.solver).toLowerCase() !== solver.toLowerCase())
    throw new SettlementPreflightError(
      'L120',
      'Bid solver mismatch',
      'Settlement caller must equal bid.solver (winning solver key).'
    )

  const bidOut = u256(bid.outputAmount)
  const minOut = u256(intent.minOutputAmount)
  if (bidOut < minOut)
    throw new SettlementPreflightError(
      'L121',
      'Bid below floor',
      `bid.outputAmount (${bidOut}) must be ≥ intent.minOutputAmount (${minOut}).`
    )

  const pref = ethers.getAddress(intent.preferredSolver ?? ethers.ZeroAddress)
  if (pref !== ethers.ZeroAddress && pref.toLowerCase() !== solver.toLowerCase())
    throw new SettlementPreflightError(
      'L126',
      'Not preferred solver',
      'Signer is not intent.preferredSolver — use the preferred solver key or leave preferredSolver as zero.'
    )

  const tier = Number(
    await withRpcRetries(() => registry.solverTier(solver))
  )
  const needTier = Number(intent.topicTier)
  if (tier < needTier)
    throw new SettlementPreflightError(
      'L128',
      'Tier mismatch',
      `solverTier(${solver.slice(0, 10)}…) is ${tier} but intent.topicTier requires >= ${needTier}.`
    )

  if (!skipErc20) {
    const token = new ethers.Contract(inTok, MockERC20ABI, provider)
    const owner = ethers.getAddress(intent.user)
    const needAmt = u256(intent.inputAmount)
    const allowance = await withRpcRetries(() =>
      token.allowance(owner, settlementAddress)
    )
    const balance = await withRpcRetries(() => token.balanceOf(owner))

    if (balance < needAmt)
      throw new SettlementPreflightError(
        'erc20.balance',
        `Insufficient ${inTok.slice(0, 10)}… balance (${balance} < ${needAmt})`,
        'User wallet must fund input tokens before settle.'
      )
    if (allowance < needAmt)
      throw new SettlementPreflightError(
        'erc20.allowance',
        `Insufficient allowance to settlement (${allowance} < ${needAmt})`,
        `Approve IntentSettlement (${settlementAddress}) for token ${inTok.slice(0, 10)}… — this tx is distinct from settle.`
      )
  }

  return { settleArgs, intentIdComputed, registryAddr }
}
