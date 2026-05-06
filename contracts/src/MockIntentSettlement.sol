// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

// ─────────────────────────────────────────────────────────────────────────────
//  MockIntentSettlement.sol
//
//  PURPOSE
//  ───────
//  A drop-in replacement for IntentSettlement.sol that exercises the entire
//  EIP-712 coordination + on-chain trust layer WITHOUT calling SwapRouter.
//
//  This is not a "stub". Every signature check, nonce guard, tier check, and
//  deadline guard from the production contract is preserved verbatim. The only
//  difference is in the execution layer: instead of routing through
//  SwapRouter.exactInput (which requires live pool liquidity), this contract
//  performs a direct ERC-20 transferFrom(user → recipient) for the inputAmount.
//
//  WHY THIS IS THE RIGHT TESTNET STORY
//  ─────────────────────────────────────
//  The Uniswap v3 pools on Arbitrum Sepolia frequently have zero active
//  liquidity in their tick range. SwapRouter's uniswapV3SwapCallback fires
//  require(amount0Delta > 0 || amount1Delta > 0), which reverts with NO revert
//  data — making it impossible to distinguish "bad intent" from "bad pool".
//  MockIntentSettlement proves that every layer up to and including the
//  execution boundary is correct. The swap router is a pluggable strategy.
//
//  CANONICAL NONCE DESIGN
//  ───────────────────────
//  This mock stores nonces locally (mapping on this contract), which is the
//  target v2 layout for IntentSettlement. In production v1, nonces are stored
//  in SolverRegistry and exposed via IntentSettlement.nonces(user) passthrough.
//  In both cases all JS callers read from `settlementContract.nonces(user)` —
//  the EIP-712 verifyingContract address — so the client API is identical.
//
// ─────────────────────────────────────────────────────────────────────────────

import {ECDSA}    from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712}   from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IERC20}   from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

// ── Minimal interface to SolverRegistry ──────────────────────────────────────
// Mirrors the functions actually called by this contract; keeps the import
// surface small and avoids coupling to internal Registry implementation.
interface ISolverRegistry {
    function isActiveAndStaked(address solver) external view returns (bool);
    function solverTier(address solver)        external view returns (uint8);
}

// ─────────────────────────────────────────────────────────────────────────────

contract MockIntentSettlement is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using ECDSA     for bytes32;

    // ── EIP-712 type strings ──────────────────────────────────────────────────
    // Must match INTENT_TYPE and BID_TYPE in sdk/domain.js exactly.
    // Any field name or type mismatch → recovered address will be wrong.

    bytes32 public constant INTENT_TYPEHASH = keccak256(
        "Intent("
        "address user,"
        "uint256 nonce,"
        "address inputToken,"
        "address outputToken,"
        "uint256 inputAmount,"
        "uint256 minOutputAmount,"
        "address recipient,"
        "uint64 deadline,"
        "uint8 topicTier,"
        "address preferredSolver"
        ")"
    );

    bytes32 public constant BID_TYPEHASH = keccak256(
        "Bid("
        "bytes32 intentId,"
        "address solver,"
        "uint256 outputAmount,"
        "bytes route,"
        "uint64 deadline"
        ")"
    );

    // ── Structs (must mirror sdk/domain.js field ordering) ───────────────────

    struct Intent {
        address user;
        uint256 nonce;
        address inputToken;
        address outputToken;
        uint256 inputAmount;
        uint256 minOutputAmount;
        address recipient;
        uint64  deadline;
        uint8   topicTier;
        address preferredSolver;
    }

    struct Bid {
        bytes32 intentId;
        address solver;
        uint256 outputAmount;
        bytes   route;        // Uniswap v3 packed path — validated for length only in mock
        uint64  deadline;
    }

    // ── State ──────────────────────────────────────────────────────────────────

    ISolverRegistry public immutable registry;

    // intentId → settled. Prevents replay of the same intent.
    mapping(bytes32 => bool) public settled;

    // Per-user nonce. Incremented after each successful settlement.
    // This is the canonical nonce source — run-user.js / intent-builder.js
    // should read from this contract, not from SolverRegistry.
    mapping(address => uint256) public nonces;

    // ── Events ────────────────────────────────────────────────────────────────

    event IntentSettled(
        bytes32 indexed intentId,
        address indexed solver,
        address indexed user,
        uint256 outputAmount,
        uint256 nonce
    );

    // Emitted instead of calling SwapRouter — makes the mock observable
    event MockExecutionSkipped(
        bytes32 indexed intentId,
        address inputToken,
        address outputToken,
        uint256 inputAmount,
        bytes   route         // retained for off-chain route verification
    );

    // ── Errors ────────────────────────────────────────────────────────────────
    // Named errors cost less gas than require strings and are decode-able
    // by ethers parseError — important for the settlement-revert.js decoder.

    error IntentAlreadySettled(bytes32 intentId);
    error IntentExpired(uint64 deadline, uint256 blockTimestamp);
    error BidExpired(uint64 bidDeadline, uint256 blockTimestamp);
    error BidExceedsIntentDeadline(uint64 bidDeadline, uint64 intentDeadline);
    error ERC20TokensOnly();
    error SolverNotRegistered(address solver);
    error InvalidIntentSignature(address recovered, address expected);
    error NonceMismatch(uint256 onChain, uint256 inIntent);
    error InvalidBidSignature(address recovered, address expected);
    error BidIntentIdMismatch(bytes32 bidIntentId, bytes32 computedIntentId);
    error BidSolverMismatch(address bidSolver, address msgSender);
    error BidBelowFloor(uint256 bidOutput, uint256 minOutput);
    error NotPreferredSolver(address preferredSolver, address actualSolver);
    error SolverTierInsufficient(uint8 solverTier, uint8 requiredTier);
    error RouteInvalidLength(uint256 length);
    error RouteInputTokenMismatch(address routeStart, address expected);
    error RouteOutputTokenMismatch(address routeEnd, address expected);

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(address _registry)
        EIP712("IntentDeFi", "1")  // must match DOMAIN in sdk/domain.js
    {
        require(_registry != address(0), "MockIntentSettlement: zero registry");
        registry = ISolverRegistry(_registry);
    }

    // ── Core settle function ──────────────────────────────────────────────────

    /**
     * @notice Settle an intent as the winning solver.
     *
     * Validates the full EIP-712 intent + bid coordination, then executes a
     * DIRECT token transfer (input token from user to recipient) instead of
     * routing through SwapRouter. This proves every coordination layer is
     * correct without testnet AMM liquidity as a dependency.
     *
     * @param intent      The user's signed intent struct.
     * @param intentSig   EIP-712 signature over intent by intent.user.
     * @param bid         The solver's winning bid struct.
     * @param bidSig      EIP-712 signature over bid by msg.sender (the solver).
     */
    function settle(
        Intent  calldata intent,
        bytes   calldata intentSig,
        Bid     calldata bid,
        bytes   calldata bidSig
    )
        external
        nonReentrant
    {
        // ── L103: replay guard ────────────────────────────────────────────────
        bytes32 intentId = _hashIntent(intent);
        if (settled[intentId])
            revert IntentAlreadySettled(intentId);

        // ── L104: intent deadline ─────────────────────────────────────────────
        // solidity's block.timestamp has ~12s granularity on L2s; fine for 10min intents.
        if (block.timestamp >= intent.deadline)
            revert IntentExpired(intent.deadline, block.timestamp);

        // ── L105 + L106: bid deadline ─────────────────────────────────────────
        if (block.timestamp >= bid.deadline)
            revert BidExpired(bid.deadline, block.timestamp);
        if (bid.deadline > intent.deadline)
            revert BidExceedsIntentDeadline(bid.deadline, intent.deadline);

        // ── L108: ERC-20 tokens only ──────────────────────────────────────────
        if (intent.inputToken == address(0) || intent.outputToken == address(0))
            revert ERC20TokensOnly();

        // ── L110: solver registration + stake ────────────────────────────────
        if (!registry.isActiveAndStaked(msg.sender))
            revert SolverNotRegistered(msg.sender);

        // ── L112: intent EIP-712 signature ────────────────────────────────────
        address recoveredIntent = _hashTypedDataV4(
            keccak256(abi.encode(
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
                intent.preferredSolver
            ))
        ).recover(intentSig);

        if (recoveredIntent != intent.user)
            revert InvalidIntentSignature(recoveredIntent, intent.user);

        // ── L114: nonce ───────────────────────────────────────────────────────
        // Nonce lives on this contract — intent-builder.js reads settlementContract.nonces().
        uint256 currentNonce = nonces[intent.user];
        if (currentNonce != intent.nonce)
            revert NonceMismatch(currentNonce, intent.nonce);

        // ── L117: bid EIP-712 signature ───────────────────────────────────────
        // route is dynamic bytes — hashed before encoding per EIP-712 spec.
        address recoveredBid = _hashTypedDataV4(
            keccak256(abi.encode(
                BID_TYPEHASH,
                bid.intentId,
                bid.solver,
                bid.outputAmount,
                keccak256(bid.route),   // bytes are hashed per EIP-712 §2.3
                bid.deadline
            ))
        ).recover(bidSig);

        if (recoveredBid != msg.sender)
            revert InvalidBidSignature(recoveredBid, msg.sender);

        // ── L119: bid intentId matches computed digest ────────────────────────
        if (bid.intentId != intentId)
            revert BidIntentIdMismatch(bid.intentId, intentId);

        // ── L120: bid.solver == msg.sender ────────────────────────────────────
        if (bid.solver != msg.sender)
            revert BidSolverMismatch(bid.solver, msg.sender);

        // ── L121: output meets floor ──────────────────────────────────────────
        if (bid.outputAmount < intent.minOutputAmount)
            revert BidBelowFloor(bid.outputAmount, intent.minOutputAmount);

        // ── L126: preferred solver ────────────────────────────────────────────
        if (intent.preferredSolver != address(0) &&
            intent.preferredSolver != msg.sender)
            revert NotPreferredSolver(intent.preferredSolver, msg.sender);

        // ── L128: tier check ──────────────────────────────────────────────────
        uint8 solverTier = registry.solverTier(msg.sender);
        if (solverTier < intent.topicTier)
            revert SolverTierInsufficient(solverTier, intent.topicTier);

        // ── Route well-formedness + token endpoint validation ─────────────────
        _validateRoute(bid.route, intent.inputToken, intent.outputToken);

        // ── Mark settled + increment nonce BEFORE external calls ─────────────
        // (check-effects-interactions pattern; nonReentrant also guards this)
        settled[intentId] = true;
        nonces[intent.user] = currentNonce + 1;

        // ── Mock execution: direct transferFrom instead of SwapRouter ─────────
        // In production IntentSettlement.sol, this is:
        //   IERC20(intent.inputToken).safeTransferFrom(intent.user, address(this), intent.inputAmount);
        //   ISwapRouter(SWAP_ROUTER).exactInput(ExactInputParams{ path, recipient, deadline, amountIn, amountOutMinimum });
        //
        // Here we prove the coordination layer works by moving the input token
        // directly to the recipient. The output token transfer is skipped —
        // the solver is not expected to have inventory on testnet.
        // The MockExecutionSkipped event carries the route for off-chain verification.
        IERC20(intent.inputToken).safeTransferFrom(
            intent.user,
            intent.recipient,
            intent.inputAmount
        );

        emit MockExecutionSkipped(
            intentId,
            intent.inputToken,
            intent.outputToken,
            intent.inputAmount,
            bid.route
        );

        emit IntentSettled(
            intentId,
            msg.sender,
            intent.user,
            bid.outputAmount,
            currentNonce
        );
    }

    // ── View helpers ──────────────────────────────────────────────────────────

    /**
     * @notice Compute the EIP-712 digest for an intent.
     * Exposed so off-chain tools (emit-settle-calldata.mjs, settle-debug.js)
     * can verify their computed intentId matches what the contract will compute.
     */
    function hashIntent(Intent calldata intent) external view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(
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
                intent.preferredSolver
            ))
        );
    }

    /**
     * @notice EIP-712 domain separator — useful for debugging signature mismatches.
     */
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    function _hashIntent(Intent calldata intent) internal view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(
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
                intent.preferredSolver
            ))
        );
    }

    function _validateRoute(bytes calldata route, address inputToken, address outputToken) internal pure {
        uint256 len = route.length;
        if (len < 43 || (len - 43) % 23 != 0) revert RouteInvalidLength(len);

        address routeStart;
        address routeEnd;
        assembly {
            routeStart := shr(96, calldataload(route.offset))
            routeEnd   := shr(96, calldataload(add(route.offset, sub(len, 20))))
        }

        if (routeStart != inputToken)  revert RouteInputTokenMismatch(routeStart, inputToken);
        if (routeEnd   != outputToken) revert RouteOutputTokenMismatch(routeEnd, outputToken);
    }
}
