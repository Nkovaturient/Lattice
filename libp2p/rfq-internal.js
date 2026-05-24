// Internal framing helpers for /defi/rfq/1.0.0 protocol (libp2p v3 MessageStream API)
import { byteStream } from '@libp2p/utils'

const _byteStreams = new WeakMap()

function isLibp2pV3Stream(stream) {
  return typeof stream?.send === 'function' && typeof stream?.addEventListener === 'function'
}

function getByteStream(stream) {
  if (!isLibp2pV3Stream(stream)) return null
  let bs = _byteStreams.get(stream)
  if (!bs) {
    bs = byteStream(stream)
    _byteStreams.set(stream, bs)
  }
  return bs
}

function toUint8Array(data) {
  if (data instanceof Uint8Array) return data
  if (typeof data?.subarray === 'function') return new Uint8Array(data.subarray())
  return new Uint8Array(data)
}

export async function writeFramed(stream, payload) {
  const frame = new Uint8Array(4 + payload.length)
  const view  = new DataView(frame.buffer)
  view.setUint32(0, payload.length, false)
  frame.set(payload, 4)

  const bs = getByteStream(stream)
  if (bs) {
    await bs.write(frame)
    return
  }

  if (typeof stream?.sink === 'function') {
    await stream.sink([frame])
    return
  }

  throw new Error('Stream has no compatible write method')
}

async function readExactLegacy(source, n) {
  const src = source?.source ?? source
  const buf = new Uint8Array(n)
  let offset = 0
  for await (const chunk of src) {
    const bytes  = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
    const needed = n - offset
    if (bytes.length >= needed) {
      buf.set(bytes.subarray(0, needed), offset)
      return buf
    }
    buf.set(bytes, offset)
    offset += bytes.length
  }
  throw new Error(`Stream ended after ${offset} bytes, expected ${n}`)
}

export async function readFramed(stream) {
  const bs = getByteStream(stream)
  if (bs) {
    const lenList = await bs.read({ bytes: 4 })
    const lenArr  = toUint8Array(lenList)
    const length  = new DataView(lenArr.buffer, lenArr.byteOffset, lenArr.byteLength).getUint32(0, false)
    if (length === 0 || length > 1_048_576) {
      throw new Error(`Invalid frame length: ${length}`)
    }
    const bodyList = await bs.read({ bytes: length })
    return toUint8Array(bodyList)
  }

  const lenBuf = await readExactLegacy(stream, 4)
  const length = new DataView(lenBuf.buffer).getUint32(0, false)
  if (length === 0 || length > 1_048_576) {
    throw new Error(`Invalid frame length: ${length}`)
  }
  return readExactLegacy(stream, length)
}

export async function closeStreamWrite(stream) {
  if (typeof stream?.closeWrite === 'function') {
    await stream.closeWrite()
    return
  }
  if (typeof stream?.close === 'function') {
    await stream.close()
  }
}
