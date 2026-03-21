// Track 3.3 — Uniswap v3 solver compute engine
// Maintains an in-memory pool state cache refreshed every block (~12s).
// Pathfinding: single-hop first, 2-hop via WETH bridge if no direct pool.
// Route encoding: Uniswap v3 packed path format via route-encoder.js.
//
// Injected into solver.js as config.computeSolution — keeps DEX logic
// separate from p2p transport logic.
import { ethers } from 'ethers'
import { encodeSingleHop, encodeTwoHop, selectFeeTier, FEE_TIERS } from '../sdk/route-encoder.js'
import { buildBid } from '../sdk/bid-builder.js'

// ── Uniswap v3 ABIs (minimal — only what we read) ────────────────────────────

const POOL_ABI = [
  'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function liquidity() external view returns (uint128)',
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
  'function fee() external view returns (uint24)',
]

const FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)',
]

// Mainnet addresses
export const UNISWAP_V3 = {
  FACTORY: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  WETH:    '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
}

// ── Pool state cache ──────────────────────────────────────────────────────────

/**
 * In-memory pool state cache.
 * Refreshed on each new block — never hits RPC during an 80ms auction window.
 *
 * Cache entry: { sqrtPriceX96, liquidity, tick, token0, token1, fee, cachedAt }
 */
export class PoolStateCache {
  #cache    = new Map()   // poolAddress → state
  #provider = null
  #factory  = null
  #watcher  = null

  constructor(provider) {
    this.#provider = provider
    this.#factory  = new ethers.Contract(UNISWAP_V3.FACTORY, FACTORY_ABI, provider)
  }

  /**
   * Start block-based refresh.
   * Call once at solver startup — runs for the lifetime of the node.
   */
  async start(poolsToWatch) {
    // Initial warm-up — fetch all watched pools before first auction
    await this._refreshAll(poolsToWatch)
    console.log(`[cache] warmed ${poolsToWatch.length} pools`)

    // Refresh on every new block
    this.#watcher = this.#provider.on('block', async (blockNum) => {
      await this._refreshAll(poolsToWatch)
        .catch(e => console.warn(`[cache] refresh failed at block ${blockNum}:`, e.message))
    })
  }

  stop() {
    if (this.#watcher) this.#provider.off('block', this.#watcher)
  }

  /**
   * Get cached pool state. Returns null if pool not cached or doesn't exist.
   */
  get(poolAddress) {
    return this.#cache.get(poolAddress.toLowerCase()) ?? null
  }

  /**
   * Resolve pool address from token pair + fee tier using the Uniswap factory.
   * Result is NOT cached — factory calls are used at startup only.
   */
  async resolvePool(tokenA, tokenB, fee) {
    const addr = await this.#factory.getPool(tokenA, tokenB, fee)
    if (addr === ethers.ZeroAddress) return null
    return addr.toLowerCase()
  }

  async _refreshAll(pools) {
    await Promise.allSettled(
      pools.map(addr => this._refreshOne(addr))
    )
  }

  async _refreshOne(poolAddress) {
    try {
      const pool     = new ethers.Contract(poolAddress, POOL_ABI, this.#provider)
      const [slot0, liquidity, token0, token1, fee] = await Promise.all([
        pool.slot0(),
        pool.liquidity(),
        pool.token0(),
        pool.token1(),
        pool.fee(),
      ])

      this.#cache.set(poolAddress.toLowerCase(), {
        sqrtPriceX96: slot0.sqrtPriceX96,
        tick:         slot0.tick,
        liquidity:    liquidity,
        token0:       token0.toLowerCase(),
        token1:       token1.toLowerCase(),
        fee:          Number(fee),
        cachedAt:     Date.now(),
      })
    } catch (e) {
      console.warn(`[cache] failed to refresh pool ${poolAddress.slice(0, 10)}:`, e.message)
    }
  }
}

// ── Output estimation ─────────────────────────────────────────────────────────

/**
 * Estimate output amount using the Uniswap v3 sqrt price formula.
 * This is an approximation — ignores tick crossings and fee impact fully.
 * Good enough for solver bid ranking in v1; production would use quoter contract.
 *
 * sqrtPriceX96 = sqrt(token1/token0) * 2^96
 *
 * @param {object} poolState   cache entry from PoolStateCache
 * @param {string} tokenIn     address of input token
 * @param {bigint} amountIn    input amount (wei)
 * @returns {bigint}           estimated output (wei)
 */
export function estimateOutput(poolState, tokenIn, amountIn) {
  const { sqrtPriceX96, token0, fee } = poolState
  const Q96     = 2n ** 96n
  const price96 = BigInt(sqrtPriceX96.toString())

  // price = (sqrtPriceX96 / 2^96)^2  gives  token1 per token0
  // Buying token1 with token0:  amountOut = amountIn * price * (1 - fee/1e6)
  // Buying token0 with token1:  amountOut = amountIn / price * (1 - fee/1e6)
  const feeFactor  = (1_000_000n - BigInt(fee)) // fee is in ppm (e.g. 3000 = 0.3%)
  const isToken0In = tokenIn.toLowerCase() === token0

  let raw
  if (isToken0In) {
    // token0 in → token1 out
    raw = (amountIn * price96 * price96) / (Q96 * Q96)
  } else {
    // token1 in → token0 out
    raw = (amountIn * Q96 * Q96) / (price96 * price96)
  }

  return (raw * feeFactor) / 1_000_000n
}

// ── Compute engine ────────────────────────────────────────────────────────────

/**
 * Create a computeSolution function bound to a specific solver signer + pool cache.
 *
 * This is what gets injected into createSolverNode({ computeSolution }).
 *
 * Pathfinding strategy (v1 — Uniswap v3 only):
 *   1. Try direct single-hop pool for each fee tier (100 → 500 → 3000 → 10000)
 *   2. If no direct pool or output < minOutputAmount, try 2-hop via WETH bridge
 *   3. Return best route, or null if nothing clears minOutputAmount
 *
 * @param {ethers.Signer}  solverSigner   solver's EVM wallet (for bid signing)
 * @param {PoolStateCache} poolCache      pre-warmed state cache
 * @returns {Function}  computeSolution(intent) → solution | null
 */
export function createComputeEngine(solverSigner, poolCache) {
  return async function computeSolution(intent) {
    const {
      inputToken, outputToken,
      inputAmount, minOutputAmount,
    } = intent

    const amountIn  = BigInt(inputAmount)
    const minOut    = BigInt(minOutputAmount)

    // ── 1. Single-hop: try each fee tier, keep best ────────────────────────
    let bestOutput = 0n
    let bestRoute  = null
    let bestFee    = null

    for (const fee of [FEE_TIERS.LOWEST, FEE_TIERS.LOW, FEE_TIERS.MEDIUM, FEE_TIERS.HIGH]) {
      const poolAddr = await poolCache.resolvePool(inputToken, outputToken, fee)
      if (!poolAddr) continue

      const state = poolCache.get(poolAddr)
      if (!state) continue  // not cached yet — skip this tier

      const estimated = estimateOutput(state, inputToken, amountIn)
      if (estimated > bestOutput) {
        bestOutput = estimated
        bestFee    = fee
        bestRoute  = encodeSingleHop(inputToken, fee, outputToken)
      }
    }

    // ── 2. Two-hop via WETH if no direct pool or below floor ───────────────
    if (bestOutput < minOut && inputToken.toLowerCase() !== UNISWAP_V3.WETH.toLowerCase()
                            && outputToken.toLowerCase() !== UNISWAP_V3.WETH.toLowerCase()) {
      const fee01 = selectFeeTier(inputToken, UNISWAP_V3.WETH)
      const fee12 = selectFeeTier(UNISWAP_V3.WETH, outputToken)

      const pool01Addr = await poolCache.resolvePool(inputToken, UNISWAP_V3.WETH, fee01)
      const pool12Addr = await poolCache.resolvePool(UNISWAP_V3.WETH, outputToken, fee12)

      if (pool01Addr && pool12Addr) {
        const state01 = poolCache.get(pool01Addr)
        const state12 = poolCache.get(pool12Addr)

        if (state01 && state12) {
          const midAmount  = estimateOutput(state01, inputToken,        amountIn)
          const finalAmount = estimateOutput(state12, UNISWAP_V3.WETH, midAmount)

          if (finalAmount > bestOutput) {
            bestOutput = finalAmount
            bestRoute  = encodeTwoHop(inputToken, fee01, UNISWAP_V3.WETH, fee12, outputToken)
          }
        }
      }
    }

    // ── 3. Cannot fill ─────────────────────────────────────────────────────
    if (!bestRoute || bestOutput < minOut) {
      console.log(`[compute] cannot fill — best output ${bestOutput} < min ${minOut}`)
      return null
    }

    // ── 4. Build + sign the bid ────────────────────────────────────────────
    const { bidObj, encodedBid } = await buildBid(
      solverSigner,
      intent,
      {
        outputAmount: bestOutput.toString(),
        encodedRoute: bestRoute,
      }
    )

    console.log(`[compute] filled — output: ${bestOutput}, route: ${bestRoute.length}B`)

    return {
      solverAddress: await solverSigner.getAddress(),
      outputAmount:  bestOutput.toString(),
      encodedRoute:  bestRoute,
      signature:     bidObj.signature,
    }
  }
}