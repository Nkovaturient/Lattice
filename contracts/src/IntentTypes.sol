// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

// Track 4.1 — EIP-712 type definitions shared across all Gossamer contracts.
// TYPEHASH values must mirror domain.js INTENT_TYPE and BID_TYPE exactly —
// field order, names, and Solidity types are the canonical source of truth.

library IntentTypes {

    // ── Type hashes ───────────────────────────────────────────────────────────

    // Verified via test/unit/eip712-parity.test.mjs
    bytes32 constant INTENT_TYPEHASH = 0x0d4e893b8ca2e1af73ef542e64756233b51d6ef4a450e4778c89898ceda17ece;

    // route is dynamic bytes — hashed separately per EIP-712 spec
    // Verified via test/unit/eip712-parity.test.mjs
    bytes32 constant BID_TYPEHASH    = 0x2e1aa209d8a4134c9a8e7fe708d82167eaf3ac87abb2c5a79b7dae3708aec2e7;

    // ── Structs ───────────────────────────────────────────────────────────────

    struct Intent {
        address user;
        uint256 nonce;
        /// @dev ERC20 only on-chain in v1; use WETH (or chain-native wrapped ETH) for ETH legs — `IntentSettlement` reverts if zero.
        address inputToken;
        address outputToken;
        uint256 inputAmount;        // exact amount in — no partial fills
        uint256 minOutputAmount;    // slippage floor
        address recipient;
        uint64  deadline;           // unix timestamp — hard on-chain expiry
        uint8   topicTier;          // 0 = public, 1 = tier-1
        address preferredSolver;    // address(0) = open auction
    }

    struct Bid {
        bytes32 intentId;
        address solver;
        uint256 outputAmount;       // guaranteed output amount
        bytes   route;              // ABI-encoded Uniswap v3 path
        uint64  deadline;           // must be <= Intent.deadline (enforced in IntentSettlement)
    }

    // ── Hashing ───────────────────────────────────────────────────────────────

    function hashIntent(Intent memory i) internal pure returns (bytes32) {
        return keccak256(abi.encode(
            INTENT_TYPEHASH,
            i.user,
            i.nonce,
            i.inputToken,
            i.outputToken,
            i.inputAmount,
            i.minOutputAmount,
            i.recipient,
            i.deadline,
            i.topicTier,
            i.preferredSolver
        ));
    }

    function hashBid(Bid memory b) internal pure returns (bytes32) {
        return keccak256(abi.encode(
            BID_TYPEHASH,
            b.intentId,
            b.solver,
            b.outputAmount,
            keccak256(b.route),     // dynamic bytes hashed separately per EIP-712
            b.deadline
        ));
    }
}
