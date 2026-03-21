// Track 2.1 — EIP-712 domain + type definitions (single source of truth)
export const DOMAIN = {
    name:              'IntentDeFi',
    version:           '1',
    chainId:           1,
    verifyingContract: process.env.SETTLEMENT_CONTRACT_ADDRESS
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