/**
 * Latency benchmark per ROADMAP 5.3.
 *
 * Probes:
 *   T0  intent received by solver
 *   T1  pool cache hit / estimateOutput
 *   T2  QuoterV2 staticcall (optional, USE_QUOTER=1)
 *   T3  bid signed
 *   T4  RFQ dial open
 *   T5  bid sent / received by coordinator
 *   T6  settlement submitted
 *
 * Quoter acceptance gate:  p95 ≤ ~25ms → default-on in hot path.
 * RFQ dial default:        60ms WS, ~40ms QUIC (see Phase F).
 */
import 'dotenv/config'
import { ethers } from 'ethers'
import { createRatedJsonRpcProvider } from '../node/rpc-provider.js'
import { quoteExactInput } from '../node/compute-engine.js'
import { encodeSingleHop, FEE_TIERS } from '../node/route-encoder.js'

// ── Config ─────────────────────────────────────────────────────────────────────

const {
  ARB_SEPOLIA_RPC,
  BENCH_QUOTER_RUNS   = '30',
  BENCH_INPUT_TOKEN   = '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', // USDC Arb Sepolia
  BENCH_OUTPUT_TOKEN  = '0x980B62Da83eFf3D4576C647993b0c1D7faf17c73', // WETH Arb Sepolia
  BENCH_AMOUNT_IN     = '1000000', // 1 USDC (6 dec)
} = process.env

if (!ARB_SEPOLIA_RPC) {
  console.error('ARB_SEPOLIA_RPC required')
  process.exit(1)
}

const runs     = Number(BENCH_QUOTER_RUNS)
const amountIn = BigInt(BENCH_AMOUNT_IN)

// ── Percentile helper ──────────────────────────────────────────────────────────

function percentile(sorted, p) {
  const idx = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, idx)]
}

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b)
  return {
    min:  s[0],
    p50:  percentile(s, 50),
    p95:  percentile(s, 95),
    p99:  percentile(s, 99),
    max:  s[s.length - 1],
    mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length),
  }
}

// ── QuoterV2 benchmark ─────────────────────────────────────────────────────────

async function benchQuoter(provider, label, path) {
  const latencies = []

  // warm-up
  await quoteExactInput(provider, path, amountIn)

  for (let i = 0; i < runs; i++) {
    const t0 = Date.now()
    const result = await quoteExactInput(provider, path, amountIn)
    const ms = Date.now() - t0
    if (result !== null) {
      latencies.push(ms)
    } else {
      console.warn(`  [run ${i}] quoter reverted`)
    }
  }

  if (latencies.length === 0) {
    console.log(`  ${label}: all runs reverted — pool may have no liquidity on this RPC`)
    return
  }

  const s = stats(latencies)
  const gate = s.p95 <= 25 ? '✓ default-on' : '✗ margin-only'
  console.log(`  ${label}: p50=${s.p50}ms p95=${s.p95}ms p99=${s.p99}ms mean=${s.mean}ms [${latencies.length}/${runs} ok] gate: ${gate}`)
  return s
}

// ── RFQ dial benchmark ─────────────────────────────────────────────────────────

async function benchRfqDial(peerId, multiaddr) {
  if (!peerId || !multiaddr) {
    console.log('  RFQ dial: skip (BENCH_SOLVER_PEER_ID + BENCH_SOLVER_MULTIADDR not set)')
    return
  }

  const { createLibp2p }  = await import('libp2p')
  const { webSockets }    = await import('@libp2p/websockets')
  const { noise }         = await import('@chainsafe/libp2p-noise')
  const { yamux }         = await import('@chainsafe/libp2p-yamux')
  const { identify }      = await import('@libp2p/identify')
  const { peerIdFromString } = await import('@libp2p/peer-id')
  const { multiaddr: ma } = await import('@multiformats/multiaddr')

  const node = await createLibp2p({
    transports: [webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify() },
  })
  await node.start()

  const latencies = []
  const pid = peerIdFromString(peerId)

  for (let i = 0; i < Math.min(runs, 10); i++) {
    const t0 = Date.now()
    try {
      const stream = await node.dialProtocol(pid, '/gossamer/rfq/1.0.0', {
        signal: AbortSignal.timeout(200),
        addresses: [ma(multiaddr)],
      })
      const ms = Date.now() - t0
      stream.close()
      latencies.push(ms)
    } catch (e) {
      console.warn(`  [rfq run ${i}] ${e.message}`)
    }
  }

  await node.stop()

  if (latencies.length === 0) {
    console.log('  RFQ dial: all attempts failed')
    return
  }

  const s = stats(latencies)
  const ws60 = s.p95 <= 60 ? '✓ within WS budget' : '✗ exceeds 60ms WS'
  const quic = s.p95 <= 40 ? '✓ within QUIC budget' : '–'
  console.log(`  RFQ dial: p50=${s.p50}ms p95=${s.p95}ms mean=${s.mean}ms ${ws60} ${quic}`)
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[bench] Arb Sepolia — ${runs} runs each`)
  console.log(`[bench] inputToken=${BENCH_INPUT_TOKEN} outputToken=${BENCH_OUTPUT_TOKEN} amountIn=${amountIn}\n`)

  const provider = createRatedJsonRpcProvider(ARB_SEPOLIA_RPC)

  const singleHop = encodeSingleHop(BENCH_INPUT_TOKEN, FEE_TIERS.MEDIUM, BENCH_OUTPUT_TOKEN)
  const twoHop    = new Uint8Array([
    ...ethers.getBytes(
      ethers.solidityPacked(
        ['address', 'uint24', 'address', 'uint24', 'address'],
        [BENCH_INPUT_TOKEN, FEE_TIERS.LOW, '0x980B62Da83eFf3D4576C647993b0c1D7faf17c73', FEE_TIERS.MEDIUM, BENCH_OUTPUT_TOKEN]
      )
    )
  ])

  console.log('=== QuoterV2 latency ===')
  const s1 = await benchQuoter(provider, '1-hop (MEDIUM 0.30%)', singleHop)
  const s2 = await benchQuoter(provider, '2-hop (LOW→MED)', twoHop)

  if (s1 || s2) {
    console.log('\nAcceptance gate: p95 ≤ 25ms → Quoter default-on in bid hot path')
    console.log('Acceptance gate: p95 > 25ms → use estimateOutput + SOLVER_MARGIN_BPS; Quoter for preflight only')
  }

  console.log('\n=== RFQ dial latency ===')
  await benchRfqDial(
    process.env.BENCH_SOLVER_PEER_ID,
    process.env.BENCH_SOLVER_MULTIADDR
  )

  console.log('\n=== GossipSub propagation ===')
  console.log('  Mesh propagation (publish → solver received): instrument via run-mesh.js timestamps')
  console.log('  Topic: /gossamer/intents/v1/evm/421614/0')
  console.log('  Dlo=2 Dhi=6 D=4 — alert when per-topic mesh count < Dlo')
  console.log('  Measure: pubsub.getMeshPeers(topic).length over time via bench-mesh multi-node harness')
}

main().catch(e => { console.error(e); process.exit(1) })
