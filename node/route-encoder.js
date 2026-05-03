// Uniswap v3 route encoding
// Converts a solver pathfinding result into the ABI-encoded bytes
// that IntentSettlement.sol passes to the Uniswap v3 SwapRouter.
//
// Uniswap v3 path format per hop:
//   tokenIn (20 bytes) + fee (3 bytes / uint24) + tokenOut (20 bytes)
// Multi-hop: tokenA + fee01 + tokenB + fee12 + tokenC  (no repeated address)
import { ethers } from 'ethers'

// Fee tiers supported by Uniswap v3
export const FEE_TIERS = {
  LOWEST:  100,    // 0.01% — stable pairs (USDC/USDT)
  LOW:     500,    // 0.05% — stable-ish pairs (USDC/WETH sometimes)
  MEDIUM:  3000,   // 0.30% — most pairs
  HIGH:    10000,  // 1.00% — exotic / low-liquidity
}

/**
 * Encode a single-hop Uniswap v3 path.
 * tokenIn → [fee] → tokenOut  =  43 bytes
 *
 * @param {string}  tokenIn   EVM address
 * @param {number}  fee       one of FEE_TIERS
 * @param {string}  tokenOut  EVM address
 * @returns {Uint8Array}  43-byte encoded path
 */
export function encodeSingleHop(tokenIn, fee, tokenOut) {
  _validateAddress(tokenIn,  'tokenIn')
  _validateAddress(tokenOut, 'tokenOut')
  _validateFee(fee)

  return ethers.getBytes(
    ethers.solidityPacked(
      ['address', 'uint24', 'address'],
      [tokenIn,   fee,      tokenOut]
    )
  )
}

/**
 * Encode a two-hop Uniswap v3 path.
 * tokenIn → [fee01] → tokenMid → [fee12] → tokenOut  =  66 bytes
 *
 * @param {string}  tokenIn   EVM address
 * @param {number}  fee01     fee for first hop
 * @param {string}  tokenMid  intermediate token address
 * @param {number}  fee12     fee for second hop
 * @param {string}  tokenOut  EVM address
 * @returns {Uint8Array}  66-byte encoded path
 */
export function encodeTwoHop(tokenIn, fee01, tokenMid, fee12, tokenOut) {
  _validateAddress(tokenIn,  'tokenIn')
  _validateAddress(tokenMid, 'tokenMid')
  _validateAddress(tokenOut, 'tokenOut')
  _validateFee(fee01)
  _validateFee(fee12)

  return ethers.getBytes(
    ethers.solidityPacked(
      ['address', 'uint24', 'address', 'uint24', 'address'],
      [tokenIn,   fee01,    tokenMid,  fee12,     tokenOut]
    )
  )
}

/**
 * Decode an encoded path back to a human-readable array of hops.
 * Useful for logging and debugging — not used in the hot path.
 *
 * @param {Uint8Array} path
 * @returns {{ tokenIn, fee, tokenOut }[]}
 */
export function decodePath(path) {
  if (path.length !== 43 && path.length !== 66) {
    throw new Error(`Unexpected path length: ${path.length} (expected 43 or 66)`)
  }
  const hops = []
  let offset = 0
  while (offset + 43 <= path.length) {
    const tokenIn  = ethers.getAddress(ethers.hexlify(path.slice(offset,      offset + 20)))
    const fee      = (path[offset+20] << 16) | (path[offset+21] << 8) | path[offset+22]
    const tokenOut = ethers.getAddress(ethers.hexlify(path.slice(offset + 23, offset + 43)))
    hops.push({ tokenIn, fee, tokenOut })
    offset += 23
  }
  return hops
}

/**
 * Pick the best fee tier for a given pool's liquidity depth.
 * In production this would read pool.liquidity from the state cache.
 * v1: use a simple heuristic — known stable pairs get LOW, everything else MEDIUM.
 */
export function selectFeeTier(tokenA, tokenB, knownStables = STABLE_ADDRS) {
  const a = tokenA.toLowerCase()
  const b = tokenB.toLowerCase()
  if (knownStables.has(a) && knownStables.has(b)) return FEE_TIERS.LOWEST
  if (knownStables.has(a) || knownStables.has(b)) return FEE_TIERS.LOW
  return FEE_TIERS.MEDIUM
}

// Well-known mainnet stable addresses for fee tier heuristic
const STABLE_ADDRS = new Set([
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
  '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT
  '0x6b175474e89094c44da98b954eedeac495271d0f', // DAI
  '0x853d955acef822db058eb8505911ed77f175b99e', // FRAX
])

// ── Validators ────────────────────────────────────────────────────────────────

function _validateAddress(addr, name) {
  if (!ethers.isAddress(addr)) throw new Error(`${name} is not a valid EVM address: ${addr}`)
}

function _validateFee(fee) {
  if (!Object.values(FEE_TIERS).includes(fee)) {
    throw new Error(`Invalid fee tier: ${fee}. Use FEE_TIERS constants.`)
  }
}