export const IntentSettlementABI = [
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
        "inputs": [],
        "name": "FailedInnerCall",
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
        "name": "InvalidRouteLength",
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
        "anonymous": false,
        "inputs": [
            {
                "indexed": true,
                "internalType": "bytes32",
                "name": "intentId",
                "type": "bytes32"
            }
        ],
        "name": "IntentExpired",
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
                "name": "user",
                "type": "address"
            },
            {
                "indexed": true,
                "internalType": "address",
                "name": "solver",
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
                "internalType": "uint256",
                "name": "outputAmount",
                "type": "uint256"
            },
            {
                "indexed": false,
                "internalType": "uint256",
                "name": "solverFee",
                "type": "uint256"
            }
        ],
        "name": "IntentSettled",
        "type": "event"
    },
    {
        "inputs": [],
        "name": "BPS_DENOMINATOR",
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
        "name": "DOMAIN_SEPARATOR",
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
        "name": "QUOTER_V2",
        "outputs": [
            {
                "internalType": "address",
                "name": "",
                "type": "address"
            }
        ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "SOLVER_FEE_BPS",
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
        "name": "SWAP_ROUTER",
        "outputs": [
            {
                "internalType": "address",
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
                "internalType": "address",
                "name": "user",
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
                "internalType": "contract SolverRegistry",
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
                "internalType": "struct IntentTypes.Intent",
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
                "internalType": "struct IntentTypes.Bid",
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
    },
    {
        "inputs": [
            {
                "internalType": "bytes32",
                "name": "",
                "type": "bytes32"
            }
        ],
        "name": "settlementActualOutput",
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
        "inputs": [
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
                "internalType": "struct IntentTypes.Bid",
                "name": "bid",
                "type": "tuple"
            },
            {
                "internalType": "bytes",
                "name": "bidSig",
                "type": "bytes"
            }
        ],
        "name": "slashForOverpromise",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    }
]