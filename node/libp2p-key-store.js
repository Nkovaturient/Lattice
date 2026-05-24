// Persist libp2p Ed25519 keys per solver EVM address.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys'

function keyDir() {
  return process.env.LIBP2P_KEY_DIR?.trim() || join(process.cwd(), '.lattice', 'libp2p-keys')
}

function keyPath(evmAddress) {
  const id = evmAddress.toLowerCase().replace(/^0x/, '')
  return join(keyDir(), `${id}.key`)
}

export async function loadOrCreateLibp2pPrivateKey(evmAddress) {
  mkdirSync(keyDir(), { recursive: true })
  const path = keyPath(evmAddress)

  if (existsSync(path)) {
    return privateKeyFromProtobuf(readFileSync(path))
  }

  const privateKey = await generateKeyPair('Ed25519')
  writeFileSync(path, privateKeyToProtobuf(privateKey), { mode: 0o600 })
  console.log(`[solver] libp2p key created → ${path}`)
  return privateKey
}
