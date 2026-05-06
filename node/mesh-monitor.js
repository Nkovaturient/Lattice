/**
 * Mesh partition monitor
 *
 * Tracks per-topic mesh peer counts, graft/prune events, and alerts when
 * the mesh drops below Dlo. Provides application-level fallback helpers.
 *
 * Topology hardening:
 *  - BOOTSTRAP_PEERS should list multiple independent relay nodes.
 *  - Solvers should redial bootstrap peers on disconnect (handled here).
 *
 * Env:
 *  MESH_DLO                 — alert threshold (default 2; matches GOSSIP_CONFIG.Dlo)
 *  MESH_DLO_ALERT_SEC       — seconds below Dlo before alert fires (default 10)
 *  MESH_RETRY_MAX           — max publish retries on empty-mesh (default 3)
 *  MESH_RETRY_JITTER_MS     — base jitter for retry backoff (default 400)
 *  BACKUP_TOPIC_ENABLED     — '1' enables publish to a backup topic if primary is empty
 */

const DLO          = Number(process.env.MESH_DLO           ?? 2)
const ALERT_SEC    = Number(process.env.MESH_DLO_ALERT_SEC ?? 10)
const RETRY_MAX    = Number(process.env.MESH_RETRY_MAX      ?? 3)
const JITTER_MS    = Number(process.env.MESH_RETRY_JITTER_MS ?? 400)
const BACKUP_ENABLED = process.env.BACKUP_TOPIC_ENABLED === '1'

/**
 * Returns the backup topic for a given primary topic.
 * Used when primary mesh is empty (partition or no solvers).
 */
export function backupTopic(primaryTopic) {
  return primaryTopic + '/fallback'
}

/**
 * Attach event listeners for graft/prune peer events.
 * Logs partition-relevant state transitions.
 *
 * @param {import('libp2p').Libp2p} node
 * @param {string[]} topics  topics to monitor
 */
export function attachMeshMonitor(node, topics) {
  const pubsub = node.services?.pubsub

  node.addEventListener('peer:connect', (evt) => {
    const id = evt.detail?.toString?.() ?? evt.detail?.id?.toString?.() ?? '?'
    console.log(`[mesh] peer:connect ${id} | total peers: ${node.getPeers().length}`)
  })

  node.addEventListener('peer:disconnect', (evt) => {
    const id = evt.detail?.toString?.() ?? evt.detail?.id?.toString?.() ?? '?'
    const total = node.getPeers().length
    console.warn(`[mesh] peer:disconnect ${id} | remaining: ${total}`)
    if (pubsub) _checkPartition(pubsub, topics)
  })

  if (pubsub) {
    _startMeshPoll(pubsub, topics)
  }
}

// ── Internal ────────────────────────────────────────────────────────────────

const _belowDloSince = new Map()

function _checkPartition(pubsub, topics) {
  for (const topic of topics) {
    const meshCount = pubsub.getMeshPeers?.(topic)?.length ?? 0
    if (meshCount < DLO) {
      if (!_belowDloSince.has(topic)) _belowDloSince.set(topic, Date.now())
      const secs = Math.floor((Date.now() - _belowDloSince.get(topic)) / 1000)
      if (secs >= ALERT_SEC) {
        console.error(
          `[mesh:ALERT] topic "${topic}" has ${meshCount} mesh peer(s) < Dlo=${DLO} for ${secs}s` +
          ' — possible mesh partition. Check BOOTSTRAP_PEERS and solver connectivity.'
        )
      }
    } else {
      _belowDloSince.delete(topic)
    }
  }
}

function _startMeshPoll(pubsub, topics) {
  const interval = Math.max(ALERT_SEC * 500, 2000)
  setInterval(() => _checkPartition(pubsub, topics), interval).unref?.()
}

// ── Publish with partition fallback ─────────────────────────────────────────

/**
 * Publish a message with retry + optional backup topic fallback.
 * Retries up to MESH_RETRY_MAX times with jittered backoff when mesh is empty.
 * If BACKUP_TOPIC_ENABLED=1 and primary subscribers remain 0, also publishes
 * to the fallback topic so solvers subscribed to it can still see the intent.
 *
 * @param {import('@libp2p/interface').PubSub} pubsub
 * @param {string} topic
 * @param {Uint8Array} message
 * @returns {Promise<void>}
 */
export async function publishWithFallback(pubsub, topic, message) {
  let lastErr = null

  for (let attempt = 0; attempt <= RETRY_MAX; attempt++) {
    const meshPeers = pubsub.getMeshPeers?.(topic)?.length ?? 0
    const subscribers = pubsub.getSubscribers?.(topic)?.length ?? 0

    if (attempt > 0) {
      const jitter = Math.random() * JITTER_MS
      const backoff = JITTER_MS * attempt + jitter
      console.warn(
        `[mesh] retry ${attempt}/${RETRY_MAX} for topic "${topic}" ` +
        `(mesh=${meshPeers} subscribers=${subscribers}) in ${Math.round(backoff)}ms`
      )
      await new Promise(r => setTimeout(r, backoff))
    }

    try {
      await pubsub.publish(topic, message)
      if (attempt > 0) console.log(`[mesh] publish succeeded on retry ${attempt}`)

      if (BACKUP_ENABLED && subscribers === 0) {
        const bt = backupTopic(topic)
        try {
          await pubsub.publish(bt, message)
          console.log(`[mesh] backup topic publish: ${bt}`)
        } catch {
          // backup is best-effort — do not fail the primary publish
        }
      }
      return
    } catch (e) {
      lastErr = e
    }
  }

  throw lastErr ?? new Error(`[mesh] publish failed after ${RETRY_MAX} retries on "${topic}"`)
}

/**
 * Log per-topic mesh metrics snapshot for monitoring.
 * Call periodically or at key lifecycle points.
 *
 * @param {import('libp2p').Libp2p} node
 * @param {string[]} topics
 */
export function logMeshMetrics(node, topics) {
  const pubsub = node.services?.pubsub
  const totalPeers = node.getPeers().length
  const rows = topics.map(t => {
    const mesh = pubsub?.getMeshPeers?.(t)?.length ?? '?'
    const subs = pubsub?.getSubscribers?.(t)?.length ?? '?'
    const alert = typeof mesh === 'number' && mesh < DLO ? ' ⚠ BELOW Dlo' : ''
    return `  ${t}: mesh=${mesh} subscribers=${subs}${alert}`
  })
  console.log(`[mesh:metrics] peers=${totalPeers} Dlo=${DLO}\n${rows.join('\n')}`)
}
