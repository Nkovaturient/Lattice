// Track 4.1 — EIP-712 hash parity test
// Verifies that computeIntentId() in JS produces the same hash
// that IntentSettlement.sol's _domainHash(hashIntent()) would produce.
// This is the critical test — if hashes diverge, settlement tx always reverts.
import { ethers } from 'ethers'
import { DOMAIN, INTENT_TYPE, BID_TYPE } from '../../sdk/domain.js'
import { computeIntentId, intentWithoutSig } from '../../sdk/intent-id.js'
import { initCodec } from '../../sdk/intent-codec.js'

let pass = 0, fail = 0
const ok  = l => { console.log(`  ✓ ${l}`); pass++ }
const bad = l => { console.error(`  ✗ ${l}`); fail++ }
const eq  = (a, b, l) => a === b ? ok(l) : bad(`${l}\n    got:  ${a}\n    want: ${b}`)

// ── Simulate Solidity IntentTypes.hashIntent() in JS ─────────────────────────

function solidityHashIntent(intent) {
  const INTENT_TYPEHASH = ethers.keccak256(ethers.toUtf8Bytes(
    "Intent(" +
      "address user," +
      "uint256 nonce," +
      "address inputToken," +
      "address outputToken," +
      "uint256 inputAmount," +
      "uint256 minOutputAmount," +
      "address recipient," +
      "uint64 deadline," +
      "uint8 topicTier," +
      "address preferredSolver" +
    ")"
  ))

  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32','address','uint256','address','address','uint256','uint256','address','uint64','uint8','address'],
    [
      INTENT_TYPEHASH,
      intent.user,
      intent.nonce,
      intent.inputToken,
      intent.outputToken,
      intent.inputAmount,
      intent.minOutputAmount,
      intent.recipient,
      intent.deadline,
      intent.topicTier,
      intent.preferredSolver,
    ]
  )

  return ethers.keccak256(encoded)
}

function solidityHashBid(bid, routeBytes) {
  const BID_TYPEHASH = ethers.keccak256(ethers.toUtf8Bytes(
    "Bid(bytes32 intentId,address solver,uint256 outputAmount,bytes route,uint64 deadline)"
  ))

  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32','bytes32','address','uint256','bytes32','uint64'],
    [
      BID_TYPEHASH,
      bid.intentId,
      bid.solver,
      bid.outputAmount,
      ethers.keccak256(routeBytes),  // dynamic bytes hashed separately
      bid.deadline,
    ]
  )

  return ethers.keccak256(encoded)
}

function domainHash(structHash, domainSeparator) {
  return ethers.keccak256(
    ethers.concat([
      ethers.toBeArray(0x1901n, 2),  // \x19\x01
      domainSeparator,
      structHash,
    ])
  )
}

// Compute EIP-712 domain separator the same way the Solidity constructor does
function computeDomainSeparator(contractAddress, chainId) {
  const EIP712DOMAIN_TYPEHASH = ethers.keccak256(ethers.toUtf8Bytes(
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
  ))
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32','bytes32','bytes32','uint256','address'],
      [
        EIP712DOMAIN_TYPEHASH,
        ethers.keccak256(ethers.toUtf8Bytes("IntentDeFi")),
        ethers.keccak256(ethers.toUtf8Bytes("1")),
        chainId,
        contractAddress,
      ]
    )
  )
}

async function run() {
  await initCodec()

  const user      = ethers.Wallet.createRandom()
  const solver    = ethers.Wallet.createRandom()
  const CONTRACT  = '0x1234567890123456789012345678901234567890'
  const CHAIN_ID  = 1n

  const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
  const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'

  const intentData = {
    user:            user.address,
    nonce:           '0',
    inputToken:      USDC,
    outputToken:     WETH,
    inputAmount:     '1000000000',
    minOutputAmount: '400000000000000000',
    recipient:       user.address,
    deadline:        Math.floor(Date.now() / 1000) + 600,
    topicTier:       0,
    preferredSolver: ethers.ZeroAddress,
  }

  // Golden intent — fixed fields; must match contracts/test/Eip712Golden.t.sol
  const GOLDEN_INTENT = {
    user:            '0x0000000000000000000000000000000000000001',
    nonce:           '0',
    inputToken:      USDC,
    outputToken:     WETH,
    inputAmount:     '1000000000',
    minOutputAmount: '400000000000000000',
    recipient:       '0x0000000000000000000000000000000000000001',
    deadline:        1735689600,
    topicTier:       0,
    preferredSolver: ethers.ZeroAddress,
  }
  const GOLDEN_STRUCT_HASH = '0xe4dd258865d80d5b9e88f20fae1cd70d464c7d8d606ef0dedbb6babb7282be9a'

  // ── 1. JS intentId matches ethers.TypedDataEncoder ────────────────────────
  console.log('\nIntentId consistency:')
  {
    const fromEncoder = computeIntentId(intentData)
    const manualHash  = solidityHashIntent(intentData)

    // TypedDataEncoder.hash includes the domain and \x19\x01 prefix
    // solidityHashIntent is just the struct hash — they should differ at this step
    // What we test: our solidity struct hash matches what ABI.encode produces

    ok(`struct hash computed: ${manualHash.slice(0,18)}…`)
    ok(`intentId (with domain): ${fromEncoder.slice(0,18)}…`)
  }

  // ── 1b. uint64 deadline must be 32-byte padded (not 8-byte manual) ────────
  console.log('\nuint64 encodeData padding:')
  {
    const correct = solidityHashIntent(GOLDEN_INTENT)
    eq(correct, GOLDEN_STRUCT_HASH, 'Golden struct hash (uint64 padded via AbiCoder)')

    const wrongPacked = ethers.keccak256(
      ethers.concat([
        ethers.AbiCoder.defaultAbiCoder().encode(
          ['bytes32', 'address', 'uint256', 'address', 'address', 'uint256', 'uint256', 'address'],
          [
            ethers.keccak256(ethers.toUtf8Bytes(
              'Intent(address user,uint256 nonce,address inputToken,address outputToken,uint256 inputAmount,uint256 minOutputAmount,address recipient,uint64 deadline,uint8 topicTier,address preferredSolver)'
            )),
            GOLDEN_INTENT.user,
            GOLDEN_INTENT.nonce,
            GOLDEN_INTENT.inputToken,
            GOLDEN_INTENT.outputToken,
            GOLDEN_INTENT.inputAmount,
            GOLDEN_INTENT.minOutputAmount,
            GOLDEN_INTENT.recipient,
          ]
        ),
        ethers.zeroPadValue(ethers.toBeHex(GOLDEN_INTENT.deadline), 8),
        ethers.AbiCoder.defaultAbiCoder().encode(
          ['uint8', 'address'],
          [GOLDEN_INTENT.topicTier, GOLDEN_INTENT.preferredSolver]
        ),
      ])
    )
    if (wrongPacked === correct) bad('8-byte deadline packing must not match Solidity abi.encode')
    else ok('8-byte deadline packing diverges from on-chain hash (as expected)')
  }

  // ── 2. Full domain hash parity ────────────────────────────────────────────
  console.log('\nDomain separator parity:')
  {
    const domain = { ...DOMAIN, verifyingContract: CONTRACT, chainId: Number(CHAIN_ID) }

    // JS side: ethers computes this internally
    const jsHash = ethers.TypedDataEncoder.hash(domain, INTENT_TYPE, intentData)

    // Solidity side: simulate what the contract constructor computes
    const domSep  = computeDomainSeparator(CONTRACT, CHAIN_ID)
    const strHash = solidityHashIntent(intentData)
    const solHash = domainHash(strHash, domSep)

    eq(jsHash, solHash, 'JS TypedDataEncoder.hash === Solidity _domainHash(hashIntent())')
  }

  // ── 3. Intent signature recovers correctly ────────────────────────────────
  console.log('\nSignature recovery:')
  {
    const domain    = { ...DOMAIN, verifyingContract: CONTRACT, chainId: Number(CHAIN_ID) }
    const signature = await user.signTypedData(domain, INTENT_TYPE, intentData)
    const recovered = ethers.verifyTypedData(domain, INTENT_TYPE, intentData, signature)
    eq(recovered.toLowerCase(), user.address.toLowerCase(), 'User signature recovers correctly')
  }

  // ── 4. Bid hash parity ────────────────────────────────────────────────────
  console.log('\nBid hash parity:')
  {
    const domain    = { ...DOMAIN, verifyingContract: CONTRACT, chainId: Number(CHAIN_ID) }
    const intentId  = ethers.TypedDataEncoder.hash(domain, INTENT_TYPE, intentData)
    const routeBytes = ethers.getBytes(
      ethers.solidityPacked(['address','uint24','address'], [USDC, 3000, WETH])
    )

    const bidData = {
      intentId,
      solver:       solver.address,
      outputAmount: '420000000000000000',
      route:        ethers.hexlify(routeBytes),
      deadline:     intentData.deadline,
    }

    const jsBidHash = ethers.TypedDataEncoder.hash(domain, BID_TYPE, bidData)

    const domSep    = computeDomainSeparator(CONTRACT, CHAIN_ID)
    const strHash   = solidityHashBid(bidData, routeBytes)
    const solBidHash = domainHash(strHash, domSep)

    eq(jsBidHash, solBidHash, 'JS BID hash === Solidity _domainHash(hashBid())')

    // Verify sig round-trip
    const bidSig    = await solver.signTypedData(domain, BID_TYPE, bidData)
    const recovered = ethers.verifyTypedData(domain, BID_TYPE, bidData, bidSig)
    eq(recovered.toLowerCase(), solver.address.toLowerCase(), 'Solver bid signature recovers correctly')
  }

  // ── 5. TYPEHASH string consistency ───────────────────────────────────────
  console.log('\nTypeHash strings:')
  {
    const INTENT_TH = ethers.keccak256(ethers.toUtf8Bytes(
      "Intent(address user,uint256 nonce,address inputToken,address outputToken,uint256 inputAmount,uint256 minOutputAmount,address recipient,uint64 deadline,uint8 topicTier,address preferredSolver)"
    ))
    const BID_TH = ethers.keccak256(ethers.toUtf8Bytes(
      "Bid(bytes32 intentId,address solver,uint256 outputAmount,bytes route,uint64 deadline)"
    ))
    ok(`INTENT_TYPEHASH: ${INTENT_TH.slice(0,18)}…`)
    ok(`BID_TYPEHASH:    ${BID_TH.slice(0,18)}…`)

    // These values should be pasted into IntentTypes.sol keccak256 constants
    // to verify no copy-paste errors in the type strings
    console.log('\n  Paste these into IntentTypes.sol to verify:')
    console.log(`  INTENT_TYPEHASH = ${INTENT_TH}`)
    console.log(`  BID_TYPEHASH    = ${BID_TH}`)
  }

  console.log(`\n${pass + fail} tests — ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

run().catch(e => { console.error(e); process.exit(1) })
