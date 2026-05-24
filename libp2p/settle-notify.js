// Notify the winning remote solver to submit settle() with its own key.
import { writeFramed, readFramed } from './rfq-internal.js'
import { serializeSettlementSnapshot } from '../node/settlement-snapshot.js'

export const SETTLE_WIN_PROTOCOL = '/defi/settle-win/1.0.0'

export function registerSettleWinHandler(node, onWin) {
  node.handle(SETTLE_WIN_PROTOCOL, async (stream, connection) => {
    const peerId = connection.remotePeer.toString()
    try {
      const payload = await readFramed(stream)
      const { intent, bid } = JSON.parse(new TextDecoder().decode(payload))
      await onWin({ intent, bid, fromPeer: peerId })
      await writeFramed(stream, new TextEncoder().encode('OK'))
      await stream.close()
    } catch (err) {
      console.warn(`[settle-win] handler error from ${peerId.slice(0, 12)}:`, err.message)
      try { stream.abort(err) } catch {}
    }
  })
}

export async function requestRemoteSettle(node, peerId, intent, bid) {
  let stream
  try {
    stream = await node.dialProtocol(peerId, SETTLE_WIN_PROTOCOL, {
      signal: AbortSignal.timeout(Number(process.env.SETTLE_NOTIFY_TIMEOUT_MS ?? 10_000)),
    })
    const body = new TextEncoder().encode(
      JSON.stringify(serializeSettlementSnapshot(intent, bid))
    )
    await writeFramed(stream, body)
    const ack = await readFramed(stream)
    const msg = new TextDecoder().decode(ack)
    if (msg !== 'OK') throw new Error(`unexpected ack: ${msg}`)
    await stream.close()
    return true
  } catch (err) {
    if (stream) try { stream.abort(err) } catch {}
    throw err
  }
}
