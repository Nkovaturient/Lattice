// Codec round-trip test — no test framework needed, run with:
//   node test/unit/codec.test.js
import { encodeIntent, decodeIntent, initCodec } from '../../sdk/intent-codec.js'
import { computeIntentId } from '../../sdk/intent-id.js'
import { DOMAIN, INTENT_TYPE } from '../../sdk/domain.js'
import { ethers } from 'ethers'

// ── Helpers ───────────────────────────────────────────────────────────────────
let passed = 0, failed = 0

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.error(`  ✗ ${label}`)
    failed++
  }
}

function assertEq(a, b, label) {
  assert(a === b, `${label}  [got: ${a}]`)
}

// ── Fixture ───────────────────────────────────────────────────────────────────
const ZERO_ADDR = ethers.ZeroAddress

async function makeSignedIntent() {
  const wallet = ethers.Wallet.createRandom()

  const data = {
    user:            wallet.address,
    nonce:           '0',
    inputToken:      '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
    outputToken:     '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
    inputAmount:     '1000000000',          // 1000 USDC (6 decimals)
    minOutputAmount: '400000000000000000',  // 0.4 WETH (18 decimals)
    recipient:       wallet.address,
    deadline:        Math.floor(Date.now() / 1000) + 600,
    topicTier:       0,
    preferredSolver: ZERO_ADDR,
  }

  const intentId = computeIntentId(data)
  const signature = await wallet.signTypedData(DOMAIN, INTENT_TYPE, data)
  return { ...data, intentId, signature }
}

// ── Tests ─────────────────────────────────────────────────────────────────────
async function run() {
  console.log('\nCodec round-trip tests\n')
  await initCodec()

  const original = await makeSignedIntent()

  // ── Encode ───────────────────────────────────────────────────────────────
  console.log('encode:')
  let encoded
  try {
    encoded = await encodeIntent(original)
    assert(encoded instanceof Uint8Array, 'returns Uint8Array')
    assert(encoded.length < 300,          `compact wire size (${encoded.length} bytes < 300)`)
    assert(encoded.length > 100,          `non-trivial payload (${encoded.length} bytes > 100)`)
  } catch (e) {
    assert(false, `no encode error — got: ${e.message}`)
    return
  }

  // ── Decode ───────────────────────────────────────────────────────────────
  console.log('\ndecode:')
  let decoded
  try {
    decoded = await decodeIntent(encoded)
    assertEq(decoded.intentId,        original.intentId,        'intentId survives')
    assertEq(decoded.user.toLowerCase(), original.user.toLowerCase(), 'user address survives')
    assertEq(decoded.nonce,           original.nonce,           'nonce survives')
    assertEq(decoded.inputToken.toLowerCase(),  original.inputToken.toLowerCase(),  'inputToken survives')
    assertEq(decoded.outputToken.toLowerCase(), original.outputToken.toLowerCase(), 'outputToken survives')
    assertEq(decoded.inputAmount,     original.inputAmount,     'inputAmount (uint256) survives')
    assertEq(decoded.minOutputAmount, original.minOutputAmount, 'minOutputAmount (uint256) survives')
    assertEq(decoded.topicTier,       original.topicTier,       'topicTier survives')
    assertEq(decoded.deadline,        original.deadline,        'deadline survives')
    assertEq(decoded.signature.toLowerCase(), original.signature.toLowerCase(), 'signature survives')
  } catch (e) {
    assert(false, `no decode error — got: ${e.message}`)
    return
  }

  // ── Signature still valid after round-trip ────────────────────────────────
  console.log('\nEIP-712 integrity:')
  try {
    const { signature, intentId, ...fields } = decoded
    const recovered = ethers.verifyTypedData(DOMAIN, INTENT_TYPE, fields, signature)
    assertEq(recovered.toLowerCase(), original.user.toLowerCase(), 'signature verifies after round-trip')

    const recomputed = computeIntentId(fields)
    assertEq(recomputed, original.intentId, 'intentId recomputes correctly')
  } catch (e) {
    assert(false, `sig verification — got: ${e.message}`)
  }

  // ── Size comparison vs JSON ───────────────────────────────────────────────
  console.log('\nsize comparison:')
  const jsonSize = new TextEncoder().encode(JSON.stringify(original)).length
  assert(encoded.length < jsonSize, `protobuf (${encoded.length}B) smaller than JSON (${jsonSize}B)`)

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

run().catch(e => { console.error(e); process.exit(1) })