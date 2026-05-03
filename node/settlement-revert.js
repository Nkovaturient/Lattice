import { ethers } from 'ethers'
import { IntentSettlementABI } from '../ABI/IntentSettlementABI.js'

export function extractRevertHex(err) {
  let e = err
  for (let i = 0; i < 12 && e; i++) {
    const d = e?.data ?? e?.error?.data
    if (typeof d === 'string' && d.startsWith('0x') && d.length > 18)
      return d
    e = e.error ?? e.cause
  }
  return typeof err?.data === 'string' ? err.data : null
}

export function decodeRevertData(data) {
  if (typeof data !== 'string' || !data.startsWith('0x') || data.length < 10)
    return null

  const sel = data.slice(0, 10)
  try {
    if (sel === '0x08c379a0') {
      const [msg] = ethers.AbiCoder.defaultAbiCoder().decode(
        ['string'],
        ethers.dataSlice(data, 4)
      )
      return typeof msg === 'string' ? msg : String(msg)
    }
    if (sel === '0x4e487b71') {
      const [code] = ethers.AbiCoder.defaultAbiCoder().decode(
        ['uint256'],
        ethers.dataSlice(data, 4)
      )
      return `Solidity panic (code ${code})`
    }
  } catch {
    return `[selector ${sel} … decode failed]`
  }

  try {
    const iface = new ethers.Interface(IntentSettlementABI)
    const pe = iface.parseError(data)
    if (pe)
      return `${pe.name}(${JSON.stringify(pe.args?.toObject?.() ?? pe.args)})`
  } catch {}

  return `[revert hex ${sel} … — callee may omit reason (often Uniswap path / liquidity)]`
}

export function parseRevertReason(err) {
  const decoded = decodeRevertData(extractRevertHex(err))
  if (decoded) return decoded
  const r = typeof err?.reason === 'string' ? err.reason : ''
  if (r.length > 0 && r !== 'require(false)')
    return r
  const sm = String(err?.shortMessage ?? err?.message ?? '')
  if (sm.includes('"')) return sm
  return null
}
