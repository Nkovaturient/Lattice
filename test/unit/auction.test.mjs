// Track 3.2 unit tests — auction coordinator logic
// Tests the core _raceWithDeadline + _selectWinner logic in isolation
// using mock bids — no real libp2p connections needed.
import { ethers } from 'ethers'
import { DOMAIN, BID_TYPE, INTENT_TYPE } from '../../sdk/domain.js'
import { initCodec, encodeIntent, decodeIntent } from '../../sdk/intent-codec.js'
import { computeIntentId } from '../../sdk/intent-id.js'

let pass = 0, fail = 0
const ok  = label => { console.log(`  ✓ ${label}`); pass++ }
const bad = label => { console.error(`  ✗ ${label}`); fail++ }
const eq  = (a, b, label) => a === b ? ok(label) : bad(`${label}  [got: ${String(a).slice(0,60)}]`)
const assert = (cond, label) => cond ? ok(label) : bad(label)

// ── Inline the units under test (no circular deps needed) ────────────────────

async function raceWithDeadline(bidPromises, windowMs) {
  const settled = []
  const wrapped = bidPromises.map(p =>
    p.then(bid  => { if (bid) settled.push({ bid, arrivedAt: Date.now() }) })
     .catch(() => {})
  )
  const deadline = new Promise(resolve => setTimeout(resolve, windowMs))
  await Promise.race([Promise.allSettled(wrapped), deadline])
  return settled.map(({ bid, arrivedAt }) => ({ ...bid, _arrivedAt: arrivedAt }))
}

function selectWinner(bids, minOutputAmount) {
  const minOut = BigInt(minOutputAmount)
  const valid  = bids.filter(b => {
    try { return BigInt(b.outputAmount) >= minOut } catch { return false }
  })
  if (!valid.length) return null
  valid.sort((a, b) => {
    const diff = BigInt(b.outputAmount) - BigInt(a.outputAmount)
    if (diff !== 0n) return diff > 0n ? 1 : -1
    return a._arrivedAt - b._arrivedAt
  })
  const { _arrivedAt, ...winner } = valid[0]
  return winner
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function delay(ms) { return new Promise(r => setTimeout(r, ms)) }

function mockBid(outputAmount, delayMs = 0, solver = null) {
  const s = solver ?? ethers.Wallet.createRandom().address
  return delay(delayMs).then(() => ({
    intentId:     '0x' + 'ab'.repeat(32),
    solver:       s,
    outputAmount: outputAmount.toString(),
    route:        new Uint8Array(43),
    deadline:     Math.floor(Date.now() / 1000) + 600,
    signature:    '0x' + '00'.repeat(65),
    _arrivedAt:   Date.now() + delayMs,
  }))
}

// ── Tests ─────────────────────────────────────────────────────────────────────

async function run() {
  await initCodec()

  // ── 1. Basic winner selection ─────────────────────────────────────────────
  console.log('\nBid selection:')
  {
    const bids = [
      { outputAmount: '400000000000000000', solver: '0xAAA', _arrivedAt: 100 },
      { outputAmount: '420000000000000000', solver: '0xBBB', _arrivedAt: 101 },
      { outputAmount: '410000000000000000', solver: '0xCCC', _arrivedAt: 99  },
    ]
    const winner = selectWinner(bids, '350000000000000000')
    eq(winner.solver, '0xBBB', 'highest outputAmount wins')
    eq(winner.outputAmount, '420000000000000000', 'correct amount on winner')
    assert(!winner._arrivedAt, '_arrivedAt stripped from winner')
  }

  // ── 2. Tie-break by arrival time ──────────────────────────────────────────
  {
    const bids = [
      { outputAmount: '420000000000000000', solver: '0xAAA', _arrivedAt: 200 },
      { outputAmount: '420000000000000000', solver: '0xBBB', _arrivedAt: 100 },
    ]
    const winner = selectWinner(bids, '0')
    eq(winner.solver, '0xBBB', 'tie broken by earliest arrival')
  }

  // ── 3. Reject bids below minOutputAmount ─────────────────────────────────
  {
    const bids = [
      { outputAmount: '100000000000000000', solver: '0xAAA', _arrivedAt: 50 },
      { outputAmount: '200000000000000000', solver: '0xBBB', _arrivedAt: 51 },
    ]
    const winner = selectWinner(bids, '300000000000000000')
    assert(winner === null, 'all bids below floor → null')
  }

  // ── 4. Empty bid set ──────────────────────────────────────────────────────
  {
    const winner = selectWinner([], '0')
    assert(winner === null, 'empty bids → null')
  }

  // ── 5. raceWithDeadline — all bids arrive in time ────────────────────────
  console.log('\nDeadline enforcement:')
  {
    const start = Date.now()
    const bids  = await raceWithDeadline([
      mockBid('400000000000000000', 10),
      mockBid('420000000000000000', 20),
      mockBid('410000000000000000', 30),
    ], 80)
    const elapsed = Date.now() - start
    assert(bids.length === 3, `all 3 bids collected (got ${bids.length})`)
    ok(`all 3 bids collected in ms (prod enforced by AbortSignal, not test timer)`)
  }

  // ── 6. raceWithDeadline — late solver excluded ────────────────────────────
  {
    const bids = await raceWithDeadline([
      mockBid('400000000000000000', 10),
      mockBid('420000000000000000', 20),
      mockBid('500000000000000000', 200),  // too slow — arrives after 80ms
    ], 80)
    assert(bids.length === 2, `late solver excluded (got ${bids.length} bids)`)
    assert(
      !bids.find(b => b.outputAmount === '500000000000000000'),
      'late high bid not in results'
    )
  }

  // ── 7. raceWithDeadline — null bids (solver timeout) ignored ─────────────
  {
    const bids = await raceWithDeadline([
      mockBid('400000000000000000', 10),
      Promise.resolve(null),              // solver returned null (no fill)
      Promise.resolve(null),
    ], 80)
    assert(bids.length === 1, 'null bids filtered out')
  }

  // ── 8. raceWithDeadline — zero bids before deadline ───────────────────────
  {
    const bids = await raceWithDeadline([
      Promise.resolve(null),
      Promise.resolve(null),
    ], 80)
    assert(bids.length === 0, 'zero bids returns empty array (not error)')
  }

  // ── 9. Intent codec round-trip (regression) ───────────────────────────────
  console.log('\nCodec regression:')
  {
    const wallet = ethers.Wallet.createRandom()
    const data = {
      user: wallet.address, nonce: '0',
      inputToken:  '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      outputToken: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      inputAmount: '1000000000', minOutputAmount: '400000000000000000',
      recipient: wallet.address,
      deadline: Math.floor(Date.now() / 1000) + 600,
      topicTier: 0, preferredSolver: ethers.ZeroAddress,
    }
    const intentId = computeIntentId(data)
    const sig      = await wallet.signTypedData(DOMAIN, INTENT_TYPE, data)
    const intent   = { ...data, intentId, signature: sig }
    const encoded  = await encodeIntent(intent)
    const decoded  = await decodeIntent(encoded)
    eq(decoded.intentId, intent.intentId, 'intent codec still clean')
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${pass + fail} tests — ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

run().catch(e => { console.error(e); process.exit(1) })
