// Track 3.3 — Uniswap v3 solver compute engine
// Maintains an in-memory pool state cache refreshed every block (~12s).
// Pathfinding: single-hop first, 2-hop via WETH bridge if no direct pool.
// Route encoding: Uniswap v3 packed path format via route-encoder.js.
//
// Injected into solver.js as config.computeSolution — keeps DEX logic
// separate from p2p transport logic.
import { ethers } from 'ethers'
import { encodeSingleHop, encodeTwoHop, selectFeeTier, FEE_TIERS } from '../node/route-encoder.js'
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

// Canonical Multicall3 — same address on Ethereum L1s/L2s including Arbitrum Sepolia
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11'
const MULTICALL3_ABI = [
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[])',
]

const poolIface = new ethers.Interface(POOL_ABI)

// Default — Ethereum mainnet (legacy export for callers that assume mainnet)
export const UNISWAP_V3 = {
  FACTORY: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  WETH:    '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
}

// Per @uniswap/sdk-core CHAIN_TO_ADDRESSES_MAP (+ canonical wrapped native)
export function uniswapV3ForChain(chainId) {
  const id = Number(chainId)
  if (id === 1) {
    return { FACTORY: UNISWAP_V3.FACTORY, WETH: UNISWAP_V3.WETH }
  }
  if (id === 42161) {
    return {
      FACTORY: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
      WETH:    '0x82aF49447D8a07e3bd95BD0d56f35241523FbAb1',
    }
  }
  if (id === 421614) {
    return {
      FACTORY: '0x248AB79Bbb9bC29bB72f7Cd42F17e054Fc40188e',
      WETH:    '0x980B62Da83eFf3D4576C647993b0c1D7faf17c73',
    }
  }
  return null
}

// ── Pool state cache ──────────────────────────────────────────────────────────

/**
 * In-memory pool state cache.
 * Refreshed on each new block — never hits RPC during an 80ms auction window.
 *
 * Cache entry: { sqrtPriceX96, liquidity, tick, token0, token1, fee, cachedAt }
 */
const MIN_REFRESH_INTERVAL_MS = 4_000
const BLOCK_DEBOUNCE_MS = 600

export class PoolStateCache {
  #cache         = new Map()   // poolAddress → state
  #provider      = null
  #factory       = null
  #weth         = null
  #blockHandler  = null
  #debounceTimer = null
  #refreshing    = false
  #lastRefreshAt = 0
  #poolsToWatch  = []

  constructor(provider) {
    this.#provider = provider
  }

  /** Wrapped native token for this chain (set in start). */
  get wrappedNative() {
    return this.#weth
  }

  /**
   * Start block-based refresh.
   * Call once at solver startup — runs for the lifetime of the node.
   */
  async start(poolsToWatch) {
    const { chainId } = await this.#provider.getNetwork()
    const u = uniswapV3ForChain(chainId)
    if (!u) {
      console.warn(`[cache] chain ${chainId} — no Uniswap v3 mapping; pool cache inactive`)
      return
    }
    this.#factory = new ethers.Contract(u.FACTORY, FACTORY_ABI, this.#provider)
    this.#weth    = u.WETH

    this.#poolsToWatch = poolsToWatch
    await this._runRefreshSafe('warmup')
    const ok = poolsToWatch.filter(a => this.get(a)).length
    console.log(`[cache] warmed ${ok}/${poolsToWatch.length} pools (chain ${chainId})`)

    this.#blockHandler = () => {
      if (this.#debounceTimer != null) clearTimeout(this.#debounceTimer)
      this.#debounceTimer = setTimeout(() => {
        this.#debounceTimer = null
        this._runRefreshSafe('block').catch(() => {})
      }, BLOCK_DEBOUNCE_MS)
    }
    await this.#provider.on('block', this.#blockHandler)
  }

  stop() {
    if (this.#debounceTimer != null) {
      clearTimeout(this.#debounceTimer)
      this.#debounceTimer = null
    }
    if (this.#blockHandler) {
      this.#provider.off('block', this.#blockHandler)
      this.#blockHandler = null
    }
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
    if (this.#factory == null) return null
    const addr = await this.#factory.getPool(tokenA, tokenB, fee)
    if (addr === ethers.ZeroAddress) return null
    return addr.toLowerCase()
  }

  async _runRefreshSafe(reason) {
    const now = Date.now()
    if (this.#refreshing) return
    if (reason !== 'warmup' && now - this.#lastRefreshAt < MIN_REFRESH_INTERVAL_MS) return
    this.#refreshing = true
    try {
      await this._refreshAllBatched(this.#poolsToWatch)
    } catch (e) {
      const msg = e?.shortMessage ?? e?.message ?? String(e)
      if (String(msg).includes('429') || String(msg).includes('Too Many')) {
        console.warn(`[cache] RPC rate-limited (${reason}) — keeping last good snapshot`)
      } else {
        console.warn(`[cache] refresh failed (${reason}):`, msg)
      }
      await this._refreshAllSequentialQuiet(this.#poolsToWatch)
    } finally {
      this.#lastRefreshAt = Date.now()
      this.#refreshing = false
    }
  }

  /** One JSON-RPC via Multicall3 — avoids N×5 concurrent eth_calls per block. */
  async _refreshAllBatched(pools) {
    if (pools.length === 0) return
    const mc = new ethers.Contract(MULTICALL3, MULTICALL3_ABI, this.#provider)
    const calls = []
    const order = []
    for (const raw of pools) {
      const checksummed = ethers.getAddress(String(raw).trim())
      order.push(checksummed)
      for (const fn of ['slot0', 'liquidity', 'token0', 'token1', 'fee']) {
        calls.push({
          target:       checksummed,
          allowFailure: true,
          callData:     poolIface.encodeFunctionData(fn, []),
        })
      }
    }
    const results = await mc.aggregate3.staticCall(calls)
    for (let i = 0; i < order.length; i++) {
      const base = i * 5
      const r0 = results[base]
      const r1 = results[base + 1]
      const r2 = results[base + 2]
      const r3 = results[base + 3]
      const r4 = results[base + 4]
      const addrLc = order[i].toLowerCase()
      try {
        if (!r0?.success || !r1?.success || !r2?.success || !r3?.success || !r4?.success) continue
        const slot0     = poolIface.decodeFunctionResult('slot0', r0.returnData)
        const liquidity = poolIface.decodeFunctionResult('liquidity', r1.returnData)[0]
        const token0    = poolIface.decodeFunctionResult('token0', r2.returnData)[0]
        const token1    = poolIface.decodeFunctionResult('token1', r3.returnData)[0]
        const fee       = poolIface.decodeFunctionResult('fee', r4.returnData)[0]

        this.#cache.set(addrLc, {
          sqrtPriceX96: slot0.sqrtPriceX96,
          tick:         slot0.tick,
          liquidity,
          token0:       token0.toLowerCase(),
          token1:       token1.toLowerCase(),
          fee:          Number(fee),
          cachedAt:     Date.now(),
        })
      } catch {
        // ignore single-pool decode failures
      }
    }
  }

  /** Fallback: one RPC at a time (quiet logs) when multicall fails. */
  async _refreshAllSequentialQuiet(pools) {
    for (const addr of pools) {
      await this._refreshOneSequential(addr)
      await new Promise(r => setTimeout(r, 75))
    }
  }

  async _refreshOneSequential(poolAddress) {
    try {
      const checksummed = ethers.getAddress(String(poolAddress).trim())
      const pool        = new ethers.Contract(checksummed, POOL_ABI, this.#provider)
      const slot0     = await pool.slot0()
      const liquidity = await pool.liquidity()
      const token0    = await pool.token0()
      const token1    = await pool.token1()
      const fee       = await pool.fee()

      this.#cache.set(checksummed.toLowerCase(), {
        sqrtPriceX96: slot0.sqrtPriceX96,
        tick:         slot0.tick,
        liquidity,
        token0:       token0.toLowerCase(),
        token1:       token1.toLowerCase(),
        fee:          Number(fee),
        cachedAt:     Date.now(),
      })
    } catch {
      // keep previous cache entry
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
    const weth = poolCache.wrappedNative
    if (weth == null) {
      console.warn('[compute] pool cache has no chain config — cannot quote')
      return null
    }

    const {
      inputToken, outputToken,
      inputAmount, minOutputAmount,
    } = intent

    const amountIn  = BigInt(inputAmount)
    const minOut    = BigInt(minOutputAmount)
    const wethLc    = weth.toLowerCase()

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
    if (bestOutput < minOut && inputToken.toLowerCase() !== wethLc
                            && outputToken.toLowerCase() !== wethLc) {
      const fee01 = selectFeeTier(inputToken, weth)
      const fee12 = selectFeeTier(weth, outputToken)

      const pool01Addr = await poolCache.resolvePool(inputToken, weth, fee01)
      const pool12Addr = await poolCache.resolvePool(weth, outputToken, fee12)

      if (pool01Addr && pool12Addr) {
        const state01 = poolCache.get(pool01Addr)
        const state12 = poolCache.get(pool12Addr)

        if (state01 && state12) {
          const midAmount   = estimateOutput(state01, inputToken, amountIn)
          const finalAmount = estimateOutput(state12, weth, midAmount)

          if (finalAmount > bestOutput) {
            bestOutput = finalAmount
            bestRoute  = encodeTwoHop(inputToken, fee01, weth, fee12, outputToken)
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