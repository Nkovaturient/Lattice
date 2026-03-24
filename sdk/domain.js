function domainChainId() {
  const raw = process.env.CHAIN_ID ?? process.env.ARB_SEPOLIA_CHAIN_ID
  if (raw == null || String(raw).trim() === '') return 1
  const n = Number(raw)
  return Number.isFinite(n) ? n : 1
}

export const DOMAIN = {
  name:              'IntentDeFi',
  version:           '1',
  chainId:           domainChainId(),
  verifyingContract: process.env.SETTLEMENT_CONTRACT_ADDRESS?.trim()
    ?? '0x0000000000000000000000000000000000000000',
}

export const INTENT_TYPE = {
  Intent: [
    { name: 'user',            type: 'address' },
    { name: 'nonce',           type: 'uint256' },
    { name: 'inputToken',      type: 'address' },
    { name: 'outputToken',     type: 'address' },
    { name: 'inputAmount',     type: 'uint256' },
    { name: 'minOutputAmount', type: 'uint256' },
    { name: 'recipient',       type: 'address' },
    { name: 'deadline',        type: 'uint64'  },
    { name: 'topicTier',       type: 'uint8'   },
    { name: 'preferredSolver', type: 'address' },
  ],
}

export const BID_TYPE = {
  Bid: [
    { name: 'intentId',     type: 'bytes32' },
    { name: 'solver',       type: 'address' },
    { name: 'outputAmount', type: 'uint256' },
    { name: 'route',        type: 'bytes'   },
    { name: 'deadline',     type: 'uint64'  },
  ],
}