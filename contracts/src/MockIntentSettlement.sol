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
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./UniswapV3Route.sol";
import "./IntentSettlementErrors.sol";

// ── Minimal interface to SolverRegistry ──────────────────────────────────────
// Mirrors the functions actually called by this contract; keeps the import
// surface small and avoids coupling to internal Registry implementation.
interface ISolverRegistry {
    function isActiveAndStaked(address solver) external view returns (bool);
    function solverTier(address solver)        external view returns (uint8);
}

// ─────────────────────────────────────────────────────────────────────────────

contract MockIntentSettlement is EIP712, ReentrancyGuard, Ownable2Step, Pausable {
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

    event IntentExpired(bytes32 indexed intentId);

    // Emitted instead of calling SwapRouter — makes the mock observable
    event MockExecutionSkipped(
        bytes32 indexed intentId,
        address inputToken,
        address outputToken,
        uint256 inputAmount,
        bytes   route         // retained for off-chain route verification
    );

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(address _registry)
        EIP712("IntentDeFi", "1") // must match DOMAIN in sdk/domain.js
        Ownable(msg.sender)
    {
        require(_registry != address(0), "MockIntentSettlement: zero registry");
        registry = ISolverRegistry(_registry);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Tombstone an expired intent for indexers; does not increment nonce.
    function markExpired(Intent calldata intent, bytes calldata intentSig) external {
        bytes32 intentId = _hashIntent(intent);
        if (settled[intentId]) revert IntentSettlementErrors.IntentAlreadySettled(intentId);
        if (block.timestamp <= intent.deadline) {
            revert IntentSettlementErrors.IntentDeadlineNotPassed(intent.deadline, block.timestamp);
        }

        _requireIntentWellFormed(intent);

        address recovered = _recoverIntentSigner(intent, intentSig);
        if (recovered != intent.user) {
            revert IntentSettlementErrors.InvalidIntentSignature(recovered, intent.user);
        }

        settled[intentId] = true;
        emit IntentExpired(intentId);
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
        whenNotPaused
    {
        // ── L103: replay guard ────────────────────────────────────────────────
        bytes32 intentId = _hashIntent(intent);
        if (settled[intentId])
            revert IntentSettlementErrors.IntentAlreadySettled(intentId);

        // ── L104: intent deadline ─────────────────────────────────────────────
        // solidity's block.timestamp has ~12s granularity on L2s; fine for 10min intents.
        if (block.timestamp >= intent.deadline)
            revert IntentSettlementErrors.IntentPastDeadline(intent.deadline, block.timestamp);

        // ── L105 + L106: bid deadline ─────────────────────────────────────────
        if (block.timestamp >= bid.deadline)
            revert IntentSettlementErrors.BidExpired(bid.deadline, block.timestamp);
        if (bid.deadline > intent.deadline)
            revert IntentSettlementErrors.BidExceedsIntentDeadline(bid.deadline, intent.deadline);

        _requireIntentWellFormed(intent);

        // ── L110: solver registration + stake ────────────────────────────────
        if (!registry.isActiveAndStaked(msg.sender))
            revert IntentSettlementErrors.SolverNotRegistered(msg.sender);

        // ── L112: intent EIP-712 signature ────────────────────────────────────
        address recoveredIntent = _recoverIntentSigner(intent, intentSig);
        if (recoveredIntent != intent.user)
            revert IntentSettlementErrors.InvalidIntentSignature(recoveredIntent, intent.user);

        // ── L114: nonce ───────────────────────────────────────────────────────
        // Nonce lives on this contract — intent-builder.js reads settlementContract.nonces().
        uint256 currentNonce = nonces[intent.user];
        if (currentNonce != intent.nonce)
            revert IntentSettlementErrors.NonceMismatch(currentNonce, intent.nonce);

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
            revert IntentSettlementErrors.InvalidBidSignature(recoveredBid, msg.sender);

        // ── L119: bid intentId matches computed digest ────────────────────────
        if (bid.intentId != intentId)
            revert IntentSettlementErrors.BidIntentIdMismatch(bid.intentId, intentId);

        // ── L120: bid.solver == msg.sender ────────────────────────────────────
        if (bid.solver != msg.sender)
            revert IntentSettlementErrors.BidSolverMismatch(bid.solver, msg.sender);

        // ── L121: output meets floor ──────────────────────────────────────────
        if (bid.outputAmount < intent.minOutputAmount)
            revert IntentSettlementErrors.BidBelowFloor(bid.outputAmount, intent.minOutputAmount);

        // ── L126: preferred solver ────────────────────────────────────────────
        if (intent.preferredSolver != address(0) &&
            intent.preferredSolver != msg.sender)
            revert IntentSettlementErrors.NotPreferredSolver(intent.preferredSolver, msg.sender);

        // ── L128: tier check ──────────────────────────────────────────────────
        uint8 solverTier = registry.solverTier(msg.sender);
        if (solverTier < intent.topicTier)
            revert IntentSettlementErrors.SolverTierInsufficient(solverTier, intent.topicTier);

        // ── Route well-formedness + token endpoint validation ─────────────────
        UniswapV3Route.validate(bid.route, intent.inputToken, intent.outputToken);

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

    function _requireIntentWellFormed(Intent calldata intent) internal pure {
        if (intent.user == address(0)) revert IntentSettlementErrors.ZeroUser();
        if (intent.inputToken == address(0) || intent.outputToken == address(0)) {
            revert IntentSettlementErrors.ERC20TokensOnly();
        }
        if (intent.recipient == address(0)) revert IntentSettlementErrors.ZeroRecipient();
        if (intent.inputAmount == 0) revert IntentSettlementErrors.ZeroInputAmount();
        if (intent.minOutputAmount == 0) revert IntentSettlementErrors.ZeroMinOutput();
    }

    function _recoverIntentSigner(Intent calldata intent, bytes calldata intentSig)
        internal
        view
        returns (address)
    {
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
        ).recover(intentSig);
    }

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

}
