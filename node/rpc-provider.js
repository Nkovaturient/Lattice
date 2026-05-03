// Shared JSON-RPC tuning for Arb Sepolia demos on public/free endpoints (heavy 429s).
import { ethers, Network } from 'ethers'

/**
 * Fewer batches + slower poll interval → fewer HTTP calls vs default JsonRpcProvider.
 * Override with RPC_POLLING_INTERVAL_MS (milliseconds).
 */
export function createRatedJsonRpcProvider(url, chainIdNum) {
  const pollingMs = Number(process.env.RPC_POLLING_INTERVAL_MS ?? '15000')

  return new ethers.JsonRpcProvider(url, Network.from(chainIdNum), {
    staticNetwork:   true,
    pollingInterval: Number.isFinite(pollingMs) && pollingMs > 0 ? pollingMs : 15_000,
    batchMaxCount:   1,
    batchStallTime:  0,
  })
}

/** True if error looks transient (429, connection noise). */
function isTransientRpcError(err) {
  const code = err?.code
  const msg = String(err?.shortMessage ?? err?.message ?? err?.info?.responseBody ?? '')
  const is429 =
    msg.includes('429')
    || msg.includes('Too Many Requests')
    || msg.includes('exceeded maximum retry limit')
  return code === 'SERVER_ERROR' || code === 'TIMEOUT' || is429 || msg.includes('ECONNRESET')
}

/**
 * Retry async work across flaky public RPC — keeps solver alive instead of crashing the process.
 */
export async function withRpcRetries(fn, { attempts = 8, baseMs = 500 } = {}) {
  let last
  const extra429 = Number(process.env.RPC_429_EXTRA_MS ?? '63000')

  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    }
    catch (e) {
      last = e
      if (!isTransientRpcError(e) || i === attempts - 1)
        throw e
      let wait = baseMs * 2 ** i
      const body = typeof e.info?.responseBody === 'string' ? e.info.responseBody : ''
      if (
        body.includes('429')
        || body.includes('Rate Limit')
        || String(e.shortMessage ?? '').includes('retry limit')
      ) {
        const bump = Number.isFinite(extra429) && extra429 > 0 ? extra429 : 63_000
        wait += bump
      }
      console.warn(`[rpc] transient RPC error; backing off ${Math.round(wait / 1000)}s (${i + 1}/${attempts - 1})`)
      await new Promise(r => setTimeout(r, wait))
    }
  }
  throw last
}
