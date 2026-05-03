import { ethers } from 'ethers'
import { IntentSettlementABI } from '../ABI/IntentSettlementABI.js'
import { withRpcRetries } from './rpc-provider.js'
import {
  assertSettlementPreflight,
  buildSettleArgs,
  SettlementPreflightError,
} from './settlement-preflight.js'
import { parseRevertReason } from './settlement-revert.js'

function explorerTxUrl(chainId, txHash) {
  const id = Number(chainId)
  if (id === 42161)
    return `https://arbiscan.io/tx/${txHash}`
  return `https://sepolia.arbiscan.io/tx/${txHash}`
}

function skipPreflight() {
  const v = process.env.SETTLE_SKIP_PREFLIGHT?.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes'
}

/**
 * Submit IntentSettlement.sol `settle` as the winning solver (must match bid.solver).
 */
export async function submitSettlement({
  provider,
  signer,
  settlementContractAddress,
  intent,
  bid,
}) {
  const settlement = new ethers.Contract(settlementContractAddress, IntentSettlementABI, signer)
  const solverAddress = ethers.getAddress(await signer.getAddress())
  const network = await withRpcRetries(() => provider.getNetwork())

  let settleArgs
  try {
    if (skipPreflight())
      settleArgs = buildSettleArgs(intent, bid)
    else
      ({
        settleArgs,
      } = await assertSettlementPreflight({
        provider,
        settlementAddress: settlementContractAddress,
        solverAddress,
        intent,
        bid,
        skipErc20: false,
      }))
  } catch (e) {
    if (e instanceof SettlementPreflightError) {
      console.error(`[preflight FAILED ${e.step}] ${e.contractMessage}`)
      if (e.fix) console.error(`  → ${e.fix}`)
    }
    throw e
  }

  const cfgGasRaw = process.env.SETTLE_GAS_LIMIT?.trim()
  let gasEstimate

  try {
    await withRpcRetries(() => settlement.settle.staticCall(...settleArgs))

    if (cfgGasRaw !== undefined && cfgGasRaw !== '')
      gasEstimate = BigInt(cfgGasRaw)
    else
      gasEstimate = await withRpcRetries(() =>
        settlement.settle.estimateGas(...settleArgs)
      )
  }
  catch (e) {
    const why = parseRevertReason(e)
    throw new Error(
      why ? `settle revert (past preflight — likely swap/router): ${why}` : `settle simulate failed: ${e.shortMessage ?? e.message}`
    )
  }

  const fee = await withRpcRetries(() => provider.getFeeData())
  const gasPrice = fee.gasPrice ?? 0n
  const src =
    cfgGasRaw !== undefined && cfgGasRaw !== ''
      ? 'SETTLE_GAS_LIMIT'
      : 'estimateGas'
  console.log(
    `[settle] gas ${src}: ${gasEstimate} (~${ethers.formatEther(BigInt(gasEstimate) * gasPrice)} ETH @ gasPrice)`
  )

  const gasLimit = (BigInt(gasEstimate) * 120n) / 100n

  const tx = await withRpcRetries(() =>
    settlement.settle(...settleArgs, { gasLimit })
  )

  console.log(`[settle] tx: ${explorerTxUrl(network.chainId, tx.hash)}`)

  const receipt = await withRpcRetries(() => tx.wait())

  console.log(`[settle] confirmed block ${receipt.blockNumber}; gasUsed ${receipt.gasUsed}`)

  const iface = new ethers.Interface(IntentSettlementABI)
  for (const lg of receipt.logs) {
    try {
      const parsed = iface.parseLog(lg)
      if (parsed?.name === 'IntentSettled') {
        console.log(
          `[settle] IntentSettled intentId=${ethers.hexlify(parsed.args.intentId)} solver=${parsed.args.solver}`
        )
      }
    } catch {}
  }

  return receipt
}
