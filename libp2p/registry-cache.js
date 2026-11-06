// Track 2.3 — In-memory solver registry cache
// 60s TTL + immediate invalidation on chain events
export class SolverRegistryCache {
    #cache = new Map()   // peerId string → { registered, evmAddress, cachedAt }
    #ttlMs = 60_000
  
    constructor(registryContract, provider) {
      this.registry = registryContract
      this.provider  = provider
      if (registryContract) this.#startEventListeners()
    }
  
    async isSolverRegistered(peerId) {
      const key   = peerId.toString()
      const entry = this.#cache.get(key)
      const now   = Date.now()
  
      // Fresh cache hit
      if (entry && (now - entry.cachedAt) < this.#ttlMs) return entry.registered
  
      // Stale or miss — fetch from chain
      const evmAddress = await this.#peerIdToEvmAddress(peerId)
      if (!evmAddress) {
        this.#cache.set(key, { registered: false, cachedAt: now })
        return false
      }
  
      const registered = await this.registry.isRegistered(evmAddress)
      this.#cache.set(key, { registered, evmAddress, cachedAt: now })
      return registered
    }
  
    invalidate(peerId) {
      this.#cache.delete(peerId.toString())
    }
  
    // Invalidate on SolverRegistered / Slashed / Deregistered via eth_getLogs polling.
    // registry.on() needs eth_newFilter, which many RPC providers disable (-32075).
    #startEventListeners() {
      const bust = addr => {
        for (const [key, entry] of this.#cache) {
          if (entry.evmAddress?.toLowerCase() === addr.toLowerCase()) {
            this.#cache.delete(key)
          }
        }
      }
      const provider = this.provider ?? this.registry.runner?.provider
      if (!provider) return

      const iface  = this.registry.interface
      const topics = ['SolverRegistered', 'SolverSlashed', 'SolverDeregistered']
        .map(name => iface.getEvent(name).topicHash)
      const address = this.registry.target
      const pollMs  = Number(process.env.RPC_POLLING_INTERVAL_MS ?? '15000')
      let lastBlock = null
      let warned    = false

      const poll = async () => {
        try {
          const head = await provider.getBlockNumber()
          lastBlock ??= head
          if (head <= lastBlock) return
          const logs = await provider.getLogs({
            address, topics: [topics], fromBlock: Math.max(lastBlock + 1, head - 2000), toBlock: head,
          })
          for (const log of logs) bust(iface.parseLog(log).args[0])
          lastBlock = head
        } catch (e) {
          if (!warned) {
            console.warn(`[registry-cache] log polling failed, relying on ${this.#ttlMs / 1000}s TTL: ${e.shortMessage ?? e.message}`)
            warned = true
          }
        }
      }

      setInterval(poll, Number.isFinite(pollMs) && pollMs > 0 ? pollMs : 15_000).unref()
    }
  
    async #peerIdToEvmAddress(peerId) {
      try { return await this.registry.peerIdToAddress(peerId.toString()) }
      catch { return null }
    }
  }