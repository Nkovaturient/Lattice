export const MockIntentSettlementABI = [
    {
        "inputs": [
            {
                "internalType": "address",
                "name": "_registry",
                "type": "address"
            }
        ],
        "stateMutability": "nonpayable",
        "type": "constructor"
    },
    {
        "inputs": [
            {
                "internalType": "address",
                "name": "target",
                "type": "address"
            }
        ],
        "name": "AddressEmptyCode",
        "type": "error"
    },
    {
        "inputs": [
            {
                "internalType": "address",
                "name": "account",
                "type": "address"
            }
        ],
        "name": "AddressInsufficientBalance",
        "type": "error"
    },
    {
        "inputs": [
            {
                "internalType": "uint256",
                "name": "bidOutput",
                "type": "uint256"
            },
            {
                "internalType": "uint256",
                "name": "minOutput",
                "type": "uint256"
            }
        ],
        "name": "BidBelowFloor",
        "type": "error"
    },
    {
        "inputs": [
            {
                "internalType": "uint64",
                "name": "bidDeadline",
                "type": "uint64"
            },
            {
                "internalType": "uint64",
                "name": "intentDeadline",
                "type": "uint64"
            }
        ],
        "name": "BidExceedsIntentDeadline",
        "type": "error"
    },
    {
        "inputs": [
            {
                "internalType": "uint64",
                "name": "bidDeadline",
                "type": "uint64"
            },
            {
                "internalType": "uint256",
                "name": "blockTimestamp",
                "type": "uint256"
            }
        ],
        "name": "BidExpired",
        "type": "error"
    },
    {
        "inputs": [
            {
                "internalType": "bytes32",
                "name": "bidIntentId",
                "type": "bytes32"
            },
            {
                "internalType": "bytes32",
                "name": "computedIntentId",
                "type": "bytes32"
            }
        ],
        "name": "BidIntentIdMismatch",
        "type": "error"
    },
    {
        "inputs": [
            {
                "internalType": "address",
                "name": "bidSolver",
                "type": "address"
            },
            {
                "internalType": "address",
                "name": "msgSender",
                "type": "address"
            }
        ],
        "name": "BidSolverMismatch",
        "type": "error"
    },
    {
        "inputs": [],
        "name": "ECDSAInvalidSignature",
        "type": "error"
    },
    {
        "inputs": [
            {
                "internalType": "uint256",
                "name": "length",
                "type": "uint256"
            }
        ],
        "name": "ECDSAInvalidSignatureLength",
        "type": "error"
    },
    {
        "inputs": [
            {
                "internalType": "bytes32",
                "name": "s",
                "type": "bytes32"
            }
        ],
        "name": "ECDSAInvalidSignatureS",
        "type": "error"
    },
    {
        "inputs": [],
        "name": "ERC20TokensOnly",
        "type": "error"
    },
    {
        "inputs": [],
        "name": "FailedInnerCall",
        "type": "error"
    },
    {
        "inputs": [
            {
                "internalType": "bytes32",
                "name": "intentId",
                "type": "bytes32"
            }
        ],
        "name": "IntentAlreadySettled",
        "type": "error"
    },
    {
        "inputs": [
            {
                "internalType": "uint64",
                "name": "deadline",
                "type": "uint64"
            },
            {
                "internalType": "uint256",
                "name": "blockTimestamp",
                "type": "uint256"
            }
        ],
        "name": "IntentExpired",
        "type": "error"
    },
    {
        "inputs": [
            {
                "internalType": "address",
                "name": "recovered",
                "type": "address"
            },
            {
                "internalType": "address",
                "name": "expected",
                "type": "address"
            }
        ],
        "name": "InvalidBidSignature",
        "type": "error"
    },
    {
        "inputs": [
            {
                "internalType": "address",
                "name": "recovered",
                "type": "address"
            },
            {
                "internalType": "address",
                "name": "expected",
                "type": "address"
            }
        ],
        "name": "InvalidIntentSignature",
        "type": "error"
    },
    {
        "inputs": [],
        "name": "InvalidShortString",
        "type": "error"
    },
    {
        "inputs": [
            {
                "internalType": "uint256",
                "name": "onChain",
                "type": "uint256"
            },
            {
                "internalType": "uint256",
                "name": "inIntent",
                "type": "uint256"
            }
        ],
        "name": "NonceMismatch",
        "type": "error"
    },
    {
        "inputs": [
            {
                "internalType": "address",
                "name": "preferredSolver",
                "type": "address"
            },
            {
                "internalType": "address",
                "name": "actualSolver",
                "type": "address"
            }
        ],
        "name": "NotPreferredSolver",
        "type": "error"
    },
    {
        "inputs": [],
        "name": "ReentrancyGuardReentrantCall",
        "type": "error"
    },
    {
        "inputs": [
            {
                "internalType": "address",
                "name": "routeStart",
                "type": "address"
            },
            {
                "internalType": "address",
                "name": "expected",
                "type": "address"
            }
        ],
        "name": "RouteInputTokenMismatch",
        "type": "error"
    },
    {
        "inputs": [
            {
                "internalType": "uint256",
                "name": "length",
                "type": "uint256"
            }
        ],
        "name": "RouteInvalidLength",
        "type": "error"
    },
    {
        "inputs": [
            {
                "internalType": "address",
                "name": "routeEnd",
                "type": "address"
            },
            {
                "internalType": "address",
                "name": "expected",
                "type": "address"
            }
        ],
        "name": "RouteOutputTokenMismatch",
        "type": "error"
    },
    {
        "inputs": [
            {
                "internalType": "address",
                "name": "token",
                "type": "address"
            }
        ],
        "name": "SafeERC20FailedOperation",
        "type": "error"
    },
    {
        "inputs": [
            {
                "internalType": "address",
                "name": "solver",
                "type": "address"
            }
        ],
        "name": "SolverNotRegistered",
        "type": "error"
    },
    {
        "inputs": [
            {
                "internalType": "uint8",
                "name": "solverTier",
                "type": "uint8"
            },
            {
                "internalType": "uint8",
                "name": "requiredTier",
                "type": "uint8"
            }
        ],
        "name": "SolverTierInsufficient",
        "type": "error"
    },
    {
        "inputs": [
            {
                "internalType": "string",
                "name": "str",
                "type": "string"
            }
        ],
        "name": "StringTooLong",
        "type": "error"
    },
    {
        "anonymous": false,
        "inputs": [],
        "name": "EIP712DomainChanged",
        "type": "event"
    },
    {
        "anonymous": false,
        "inputs": [
            {
                "indexed": true,
                "internalType": "bytes32",
                "name": "intentId",
                "type": "bytes32"
            },
            {
                "indexed": true,
                "internalType": "address",
                "name": "solver",
                "type": "address"
            },
            {
                "indexed": true,
                "internalType": "address",
                "name": "user",
                "type": "address"
            },
            {
                "indexed": false,
                "internalType": "uint256",
                "name": "outputAmount",
                "type": "uint256"
            },
            {
                "indexed": false,
                "internalType": "uint256",
                "name": "nonce",
                "type": "uint256"
            }
        ],
        "name": "IntentSettled",
        "type": "event"
    },
    {
        "anonymous": false,
        "inputs": [
            {
                "indexed": true,
                "internalType": "bytes32",
                "name": "intentId",
                "type": "bytes32"
            },
            {
                "indexed": false,
                "internalType": "address",
                "name": "inputToken",
                "type": "address"
            },
            {
                "indexed": false,
                "internalType": "address",
                "name": "outputToken",
                "type": "address"
            },
            {
                "indexed": false,
                "internalType": "uint256",
                "name": "inputAmount",
                "type": "uint256"
            },
            {
                "indexed": false,
                "internalType": "bytes",
                "name": "route",
                "type": "bytes"
            }
        ],
        "name": "MockExecutionSkipped",
        "type": "event"
    },
    {
        "inputs": [],
        "name": "BID_TYPEHASH",
        "outputs": [
            {
                "internalType": "bytes32",
                "name": "",
                "type": "bytes32"
            }
        ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "INTENT_TYPEHASH",
        "outputs": [
            {
                "internalType": "bytes32",
                "name": "",
                "type": "bytes32"
            }
        ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "domainSeparator",
        "outputs": [
            {
                "internalType": "bytes32",
                "name": "",
                "type": "bytes32"
            }
        ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "eip712Domain",
        "outputs": [
            {
                "internalType": "bytes1",
                "name": "fields",
                "type": "bytes1"
            },
            {
                "internalType": "string",
                "name": "name",
                "type": "string"
            },
            {
                "internalType": "string",
                "name": "version",
                "type": "string"
            },
            {
                "internalType": "uint256",
                "name": "chainId",
                "type": "uint256"
            },
            {
                "internalType": "address",
                "name": "verifyingContract",
                "type": "address"
            },
            {
                "internalType": "bytes32",
                "name": "salt",
                "type": "bytes32"
            },
            {
                "internalType": "uint256[]",
                "name": "extensions",
                "type": "uint256[]"
            }
        ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [
            {
                "components": [
                    {
                        "internalType": "address",
                        "name": "user",
                        "type": "address"
                    },
                    {
                        "internalType": "uint256",
                        "name": "nonce",
                        "type": "uint256"
                    },
                    {
                        "internalType": "address",
                        "name": "inputToken",
                        "type": "address"
                    },
                    {
                        "internalType": "address",
                        "name": "outputToken",
                        "type": "address"
                    },
                    {
                        "internalType": "uint256",
                        "name": "inputAmount",
                        "type": "uint256"
                    },
                    {
                        "internalType": "uint256",
                        "name": "minOutputAmount",
                        "type": "uint256"
                    },
                    {
                        "internalType": "address",
                        "name": "recipient",
                        "type": "address"
                    },
                    {
                        "internalType": "uint64",
                        "name": "deadline",
                        "type": "uint64"
                    },
                    {
                        "internalType": "uint8",
                        "name": "topicTier",
                        "type": "uint8"
                    },
                    {
                        "internalType": "address",
                        "name": "preferredSolver",
                        "type": "address"
                    }
                ],
                "internalType": "struct MockIntentSettlement.Intent",
                "name": "intent",
                "type": "tuple"
            }
        ],
        "name": "hashIntent",
        "outputs": [
            {
                "internalType": "bytes32",
                "name": "",
                "type": "bytes32"
            }
        ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [
            {
                "internalType": "address",
                "name": "",
                "type": "address"
            }
        ],
        "name": "nonces",
        "outputs": [
            {
                "internalType": "uint256",
                "name": "",
                "type": "uint256"
            }
        ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "registry",
        "outputs": [
            {
                "internalType": "contract ISolverRegistry",
                "name": "",
                "type": "address"
            }
        ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [
            {
                "components": [
                    {
                        "internalType": "address",
                        "name": "user",
                        "type": "address"
                    },
                    {
                        "internalType": "uint256",
                        "name": "nonce",
                        "type": "uint256"
                    },
                    {
                        "internalType": "address",
                        "name": "inputToken",
                        "type": "address"
                    },
                    {
                        "internalType": "address",
                        "name": "outputToken",
                        "type": "address"
                    },
                    {
                        "internalType": "uint256",
                        "name": "inputAmount",
                        "type": "uint256"
                    },
                    {
                        "internalType": "uint256",
                        "name": "minOutputAmount",
                        "type": "uint256"
                    },
                    {
                        "internalType": "address",
                        "name": "recipient",
                        "type": "address"
                    },
                    {
                        "internalType": "uint64",
                        "name": "deadline",
                        "type": "uint64"
                    },
                    {
                        "internalType": "uint8",
                        "name": "topicTier",
                        "type": "uint8"
                    },
                    {
                        "internalType": "address",
                        "name": "preferredSolver",
                        "type": "address"
                    }
                ],
                "internalType": "struct MockIntentSettlement.Intent",
                "name": "intent",
                "type": "tuple"
            },
            {
                "internalType": "bytes",
                "name": "intentSig",
                "type": "bytes"
            },
            {
                "components": [
                    {
                        "internalType": "bytes32",
                        "name": "intentId",
                        "type": "bytes32"
                    },
                    {
                        "internalType": "address",
                        "name": "solver",
                        "type": "address"
                    },
                    {
                        "internalType": "uint256",
                        "name": "outputAmount",
                        "type": "uint256"
                    },
                    {
                        "internalType": "bytes",
                        "name": "route",
                        "type": "bytes"
                    },
                    {
                        "internalType": "uint64",
                        "name": "deadline",
                        "type": "uint64"
                    }
                ],
                "internalType": "struct MockIntentSettlement.Bid",
                "name": "bid",
                "type": "tuple"
            },
            {
                "internalType": "bytes",
                "name": "bidSig",
                "type": "bytes"
            }
        ],
        "name": "settle",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [
            {
                "internalType": "bytes32",
                "name": "",
                "type": "bytes32"
            }
        ],
        "name": "settled",
        "outputs": [
            {
                "internalType": "bool",
                "name": "",
                "type": "bool"
            }
        ],
        "stateMutability": "view",
        "type": "function"
    }
]