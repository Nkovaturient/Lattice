// Internal framing helpers for /defi/rfq/1.0.0 protocol

// Write a length-prefixed message into a stream sink
export async function writeFramed(stream, payload) {
  const frame = new Uint8Array(4 + payload.length)
  const view  = new DataView(frame.buffer)
  view.setUint32(0, payload.length, false)  // big-endian uint32
  frame.set(payload, 4)
  await stream.sink([frame])
}

// Read exactly n bytes from an async-iterable stream source.
// Loops across chunks — chunks have no guaranteed boundary alignment.
async function readExact(source, n) {
  const buf = new Uint8Array(n)
  let offset = 0
  for await (const chunk of source) {
    const bytes  = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
    const needed = n - offset
    if (bytes.length >= needed) {
      buf.set(bytes.subarray(0, needed), offset)
      return buf          // accumulated enough — done
    }
    buf.set(bytes, offset)
    offset += bytes.length  // need more chunks — keep reading
  }
  throw new Error(`Stream ended after ${offset} bytes, expected ${n}`)
}

// Read one length-prefixed frame from a stream source
export async function readFramed(source) {
  const lenBuf = await readExact(source, 4)
  const length = new DataView(lenBuf.buffer).getUint32(0, false)  // big-endian
  if (length === 0 || length > 1_048_576) {
    throw new Error(`Invalid frame length: ${length}`)             // sanity: 0 < len < 1MB
  }
  return readExact(source, length)
}
