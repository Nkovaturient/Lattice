// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import "./IntentTypes.sol";
import "./SolverRegistry.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

// Minimal interface — only what we call on the SwapRouter
interface ISwapRouter {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

// Track 4.1 — Intent settlement contract.
// Verifies both EIP-712 signatures, executes the Uniswap v3 swap via the
// encoded route, checks output >= minOutputAmount, pays the solver fee,
// and protects against replay via per-user nonces.

contract IntentSettlement is ReentrancyGuard {
    using IntentTypes for IntentTypes.Intent;
    using IntentTypes for IntentTypes.Bid;
    using SafeERC20 for IERC20;

    // ── Constants ─────────────────────────────────────────────────────────────

    // EIP-712 domain — must match domain.js DOMAIN exactly
    bytes32 public immutable DOMAIN_SEPARATOR;

    // Protocol fee: solver earns SOLVER_FEE_BPS basis points of output surplus
    // Surplus = actualOutput - minOutputAmount
    uint256 public constant SOLVER_FEE_BPS = 500; // 5% of surplus
    uint256 public constant BPS_DENOMINATOR = 10_000;

    // Uniswap v3 SwapRouter (same address Arbitrum mainnet + Sepolia)
    address public constant SWAP_ROUTER = 0xE592427A0AEce92De3Edee1F18E0157C05861564;
    address public constant QUOTER_V2 = 0x61fFE014bA17989E743c5F6cB21bF9697530B21e;

    // ── State ─────────────────────────────────────────────────────────────────

    SolverRegistry public immutable registry;

    // Replay protection: intentId → settled
    mapping(bytes32 => bool) public settled;

    /// @dev Actual output token amount from the swap, recorded for on-chain overpromise checks.
    mapping(bytes32 => uint256) public settlementActualOutput;

    // ── Custom errors ─────────────────────────────────────────────────────────

    /// Route bytes are not a valid packed Uniswap v3 path (must be 43 + 23*n bytes).
    error InvalidRouteLength(uint256 length);

    /// Route first token does not match intent.inputToken.
    error RouteInputTokenMismatch(address routeStart, address expected);

    /// Route last token does not match intent.outputToken.
    error RouteOutputTokenMismatch(address routeEnd, address expected);

    // ── Events ────────────────────────────────────────────────────────────────

    event IntentSettled(
        bytes32 indexed intentId,
        address indexed user,
        address indexed solver,
        uint256 inputAmount,
        uint256 outputAmount,
        uint256 solverFee
    );

    event IntentExpired(bytes32 indexed intentId);

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(address _registry) {
        registry = SolverRegistry(_registry);

        // Compute EIP-712 domain separator — mirrors domain.js DOMAIN
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("IntentDeFi"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }

    // ── Settlement ────────────────────────────────────────────────────────────

    /**
     * Settle an intent with a winning solver bid.
     * CEI: replay + nonce effects occur before any external call; recorded output
     * and fill accounting occur before paying recipient/solver (nonReentrant on whole flow).
     */
    function settle(
        IntentTypes.Intent calldata intent,
        bytes calldata intentSig,
        IntentTypes.Bid calldata bid,
        bytes calldata bidSig
    ) external nonReentrant {
        bytes32 intentId = _domainHash(intent.hashIntent());
        require(!settled[intentId], "Intent already settled");

        require(block.timestamp <= intent.deadline, "Intent expired");
        require(block.timestamp <= bid.deadline, "Bid expired");
        require(bid.deadline <= intent.deadline, "Bid extends past intent");

        require(intent.inputToken != address(0) && intent.outputToken != address(0), "ERC20 only");

        require(registry.isActiveAndStaked(msg.sender), "Solver not registered");

        require(_verifySignature(intentId, intentSig, intent.user), "Invalid intent signature");

        require(registry.nonces(intent.user) == intent.nonce, "Nonce mismatch");

        bytes32 bidHash = _domainHash(bid.hashBid());
        require(_verifySignature(bidHash, bidSig, msg.sender), "Invalid bid signature");

        require(bid.intentId == intentId, "Bid intentId mismatch");
        require(bid.solver == msg.sender, "Bid solver mismatch");
        require(bid.outputAmount >= intent.minOutputAmount, "Bid below floor");

        // Signed intent fields: enforce preferred solver and topic tier
        require(
            intent.preferredSolver == address(0) || intent.preferredSolver == msg.sender,
            "Not preferred solver"
        );
        require(registry.solverTier(msg.sender) >= intent.topicTier, "Tier mismatch");

        _validateRoute(bid.route, intent.inputToken, intent.outputToken);

        // Effects before any external call (CEI) — blocks reentrant double-settlement
        settled[intentId] = true;
        registry.incrementNonce(intent.user);

        IERC20 input = IERC20(intent.inputToken);
        input.safeTransferFrom(intent.user, address(this), intent.inputAmount);
        input.forceApprove(SWAP_ROUTER, intent.inputAmount);

        uint256 actualOutput = ISwapRouter(SWAP_ROUTER).exactInput(
            ISwapRouter.ExactInputParams({
                path: bid.route,
                recipient: address(this),
                deadline: bid.deadline,
                amountIn: intent.inputAmount,
                amountOutMinimum: intent.minOutputAmount
            })
        );

        require(actualOutput >= intent.minOutputAmount, "Output below minimum");

        (uint256 userGets, uint256 solverFee) = _feeSplit(actualOutput, intent.minOutputAmount);

        // Record before outbound transfers (CEI) — binds slashForOverpromise to on-chain truth
        settlementActualOutput[intentId] = actualOutput;
        registry.recordFill(msg.sender);

        _payOutputsAndCleanup(
            IERC20(intent.outputToken),
            intent.recipient,
            intent.inputToken,
            userGets,
            solverFee,
            intentId,
            intent.user,
            intent.inputAmount,
            actualOutput
        );
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    /**
     * @notice Returns the current intent nonce for a user.
     * Storage lives on SolverRegistry in v1 (internal detail). This passthrough
     * lets every client read through the settlement address — the EIP-712
     * verifyingContract — instead of coupling to the registry address.
     * In v2, storage moves here; clients require no change.
     */
    function nonces(address user) external view returns (uint256) {
        return registry.nonces(user);
    }

    // ── Slash helpers ─────────────────────────────────────────────────────────

    /**
     * Slash a solver who bid outputAmount above what settlement produced.
     * Uses the output amount recorded at settlement time — callers cannot inject a fake actualOutput.
     * Uses `slashOverpromise` so deregistered solvers (e.g. after an earlier auto-slash) still get
     * `slashes` / events when no stake remains to take.
     */
    function slashForOverpromise(IntentTypes.Bid calldata bid, bytes calldata bidSig) external {
        bytes32 bidHash = _domainHash(bid.hashBid());
        require(_verifySignature(bidHash, bidSig, bid.solver), "Invalid bid signature");

        bytes32 intentId = bid.intentId;
        require(settled[intentId], "Intent not settled");
        uint256 recorded = settlementActualOutput[intentId];
        require(recorded < bid.outputAmount, "No overpromise to slash");

        registry.slashOverpromise(bid.solver);
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    function _feeSplit(uint256 actualOutput, uint256 minOutputAmount)
        private
        pure
        returns (uint256 userGets, uint256 solverFee)
    {
        uint256 surplus = actualOutput - minOutputAmount;
        solverFee = (surplus * SOLVER_FEE_BPS) / BPS_DENOMINATOR;
        userGets = actualOutput - solverFee;
    }

    function _payOutputsAndCleanup(
        IERC20 outputToken,
        address recipient,
        address inputToken,
        uint256 userGets,
        uint256 solverFee,
        bytes32 intentId,
        address user,
        uint256 inputAmount,
        uint256 actualOutput
    ) private {
        outputToken.safeTransfer(recipient, userGets);
        outputToken.safeTransfer(msg.sender, solverFee);
        IERC20(inputToken).forceApprove(SWAP_ROUTER, 0);
        emit IntentSettled(intentId, user, msg.sender, inputAmount, actualOutput, solverFee);
    }

    /**
     * Validate packed Uniswap v3 path well-formedness and token endpoint alignment.
     * Each hop: tokenA(20) + fee(3) + tokenB(20); consecutive hops share the bridge token.
     * Valid lengths: 43 (1-hop) or 43 + 23*n (n additional hops).
     * Reverts with custom errors so callers can diagnose route vs signature issues distinctly.
     */
    function _validateRoute(bytes calldata route, address inputToken, address outputToken) internal pure {
        uint256 len = route.length;
        if (len < 43 || (len - 43) % 23 != 0) revert InvalidRouteLength(len);

        address routeStart;
        address routeEnd;
        assembly {
            // first 20 bytes = tokenIn
            routeStart := shr(96, calldataload(route.offset))
            // last 20 bytes = tokenOut (starts at offset + len - 20)
            routeEnd   := shr(96, calldataload(add(route.offset, sub(len, 20))))
        }

        if (routeStart != inputToken)  revert RouteInputTokenMismatch(routeStart, inputToken);
        if (routeEnd   != outputToken) revert RouteOutputTokenMismatch(routeEnd, outputToken);
    }

    function _domainHash(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    /// @dev Uses OZ ECDSA: rejects EIP-2 malleable signatures (high `s`, invalid `v`) and never treats
    ///      `ecrecover` failure as matching `expected` (including `expected == address(0)`).
    function _verifySignature(bytes32 hash, bytes calldata sig, address expected) internal pure returns (bool) {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, bytes(sig));
        return err == ECDSA.RecoverError.NoError && recovered == expected;
    }
}
