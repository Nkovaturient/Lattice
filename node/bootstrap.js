// Bootstrap / rendezvous node
import { createLibp2p } from 'libp2p'
import { webSockets } from '@libp2p/websockets'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { kadDHT } from '@libp2p/kad-dht'

export async function createBootstrapNode(port = 9100) {
  const node = await createLibp2p({
    addresses: { listen: [`/ip4/0.0.0.0/tcp/${port}/ws`] },
    transports: [webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      dht: kadDHT({ clientMode: false }),
    },
  })
  await node.start()
  console.log(`Bootstrap node ready:`)
  console.log(`  /ip4/127.0.0.1/tcp/${port}/ws/p2p/${node.peerId}`)
  return node
}