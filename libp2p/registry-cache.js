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
  
    // Immediate invalidation on SolverRegistered / Slashed / Deregistered events
    #startEventListeners() {
      const bust = addr => {
        for (const [key, entry] of this.#cache) {
          if (entry.evmAddress?.toLowerCase() === addr.toLowerCase()) {
            this.#cache.delete(key)
          }
        }
      }
      this.registry.on('SolverRegistered',   bust)
      this.registry.on('SolverSlashed',      bust)
      this.registry.on('SolverDeregistered', bust)
    }
  
    async #peerIdToEvmAddress(peerId) {
      try { return await this.registry.peerIdToAddress(peerId.toString()) }
      catch { return null }
    }
  }