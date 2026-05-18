// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import "./IntentTypes.sol";
import "./SolverRegistry.sol";
import "./UniswapV3Route.sol";
import "./IntentSettlementErrors.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

// Minimal interface — Uniswap V3 SwapRouter **v1** `exactInput` (includes `deadline` in params).
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

contract IntentSettlement is ReentrancyGuard, Ownable2Step, Pausable {
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

    /// @dev Min bid-vs-recorded shortfall (bps of `bid.outputAmount`) to allow slash — blocks dust griefing.
    uint256 public constant MIN_OVERPROMISE_BPS = 10; // 0.1% (~1e15 wei on 1 WETH-scale output)

    /// @notice Uniswap V3 **SwapRouter (v1)** — `exactInput` with `deadline` in `ExactInputParams`.
    /// @dev Immutable by design: router upgrades (SwapRouter02, V4, etc.) require redeploying this contract.
    ///      We stay on v1 (not SwapRouter02 `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45`) because v2's
    ///      `exactInput` drops the deadline field — bids carry `bid.deadline` and v1 matches that API.
    ///      v1 remains live on Arbitrum One / Sepolia at this address; v2 is preferred for greenfield apps.
    address public constant SWAP_ROUTER = 0xE592427A0AEce92De3Edee1F18E0157C05861564;

    /// @notice Uniswap V3 QuoterV2 — for off-chain route quoting only; not called in `settle`.
    address public constant QUOTER_V2 = 0x61fFE014bA17989E743c5F6cB21bF9697530B21e;

    /// @dev Documented reference only — not used on-chain in v1.
    address public constant SWAP_ROUTER02 = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45;

    // ── State ─────────────────────────────────────────────────────────────────

    SolverRegistry public immutable registry;

    // Replay protection: intentId → settled
    mapping(bytes32 => bool) public settled;

    /// @dev Actual output token amount from the swap, recorded for on-chain overpromise checks.
    mapping(bytes32 => uint256) public settlementActualOutput;

    /// @dev One overpromise slash per intent — prevents replay griefing the same bid+sig.
    mapping(bytes32 => bool) public slashedForOverpromise;

    /// @dev When `settlementActualOutput` was recorded (unix seconds); used for slash-window pruning.
    mapping(bytes32 => uint64) public settlementRecordedAt;

    /// @dev After this period, `pruneSettlementRecord` may delete output metadata if unslashed.
    uint64 public constant SLASH_WINDOW = 7 days;

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

    event SettlementRecordPruned(bytes32 intentId);

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(address _registry) Ownable(msg.sender) {
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

    // ── Emergency pause ───────────────────────────────────────────────────────

    /// @notice Halt new settlements while investigating an incident. `slashForOverpromise` stays live.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
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
    ) external nonReentrant whenNotPaused {
        bytes32 intentId = _domainHash(intent.hashIntent());
        if (settled[intentId]) revert IntentSettlementErrors.IntentAlreadySettled(intentId);

        if (block.timestamp > intent.deadline) {
            revert IntentSettlementErrors.IntentPastDeadline(intent.deadline, block.timestamp);
        }
        if (block.timestamp > bid.deadline) {
            revert IntentSettlementErrors.BidExpired(bid.deadline, block.timestamp);
        }
        if (bid.deadline > intent.deadline) {
            revert IntentSettlementErrors.BidExceedsIntentDeadline(bid.deadline, intent.deadline);
        }

        _requireIntentWellFormed(intent);

        if (!registry.isActiveAndStaked(msg.sender)) {
            revert IntentSettlementErrors.SolverNotRegistered(msg.sender);
        }

        _requireIntentSignature(intentId, intentSig, intent.user);

        uint256 onChainNonce = registry.nonces(intent.user);
        if (onChainNonce != intent.nonce) {
            revert IntentSettlementErrors.NonceMismatch(onChainNonce, intent.nonce);
        }

        bytes32 bidHash = _domainHash(bid.hashBid());
        _requireBidSignature(bidHash, bidSig, msg.sender);

        if (bid.intentId != intentId) {
            revert IntentSettlementErrors.BidIntentIdMismatch(bid.intentId, intentId);
        }
        if (bid.solver != msg.sender) {
            revert IntentSettlementErrors.BidSolverMismatch(bid.solver, msg.sender);
        }
        if (bid.outputAmount < intent.minOutputAmount) {
            revert IntentSettlementErrors.BidBelowFloor(bid.outputAmount, intent.minOutputAmount);
        }

        if (intent.preferredSolver != address(0) && intent.preferredSolver != msg.sender) {
            revert IntentSettlementErrors.NotPreferredSolver(intent.preferredSolver, msg.sender);
        }
        uint8 tier = registry.solverTier(msg.sender);
        if (tier < intent.topicTier) {
            revert IntentSettlementErrors.SolverTierInsufficient(tier, intent.topicTier);
        }

        UniswapV3Route.validate(bid.route, intent.inputToken, intent.outputToken);

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

        if (actualOutput < intent.minOutputAmount) {
            revert IntentSettlementErrors.OutputBelowMinimum(actualOutput, intent.minOutputAmount);
        }

        (uint256 userGets, uint256 solverFee) = _feeSplit(actualOutput, intent.minOutputAmount);

        // Record before outbound transfers (CEI) — binds slashForOverpromise to on-chain truth
        settlementActualOutput[intentId] = actualOutput;
        settlementRecordedAt[intentId] = uint64(block.timestamp);
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

    /**
     * @notice Tombstone an intent after its deadline and emit `IntentExpired`.
     * @dev Anyone may call with a valid user signature. Does not increment nonce.
     *      Further `settle` attempts revert `IntentAlreadySettled`.
     */
    function markExpired(IntentTypes.Intent calldata intent, bytes calldata intentSig) external {
        bytes32 intentId = _domainHash(intent.hashIntent());
        if (settled[intentId]) revert IntentSettlementErrors.IntentAlreadySettled(intentId);
        if (block.timestamp <= intent.deadline) {
            revert IntentSettlementErrors.IntentDeadlineNotPassed(intent.deadline, block.timestamp);
        }

        _requireIntentWellFormed(intent);
        _requireIntentSignature(intentId, intentSig, intent.user);

        settled[intentId] = true;
        emit IntentExpired(intentId);
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
     * Shortfall must be at least `MIN_OVERPROMISE_BPS` of the bid (output-token units) to block dust griefing.
     * Uses `slashOverpromise` so deregistered solvers (e.g. after an earlier auto-slash) still get
     * `slashes` / events when no stake remains to take.
     */
    function slashForOverpromise(IntentTypes.Bid calldata bid, bytes calldata bidSig) external {
        bytes32 bidHash = _domainHash(bid.hashBid());
        _requireBidSignature(bidHash, bidSig, bid.solver);

        bytes32 intentId = bid.intentId;
        if (!settled[intentId]) revert IntentSettlementErrors.IntentNotSettled(intentId);
        if (slashedForOverpromise[intentId]) {
            revert IntentSettlementErrors.AlreadySlashedForOverpromise(intentId);
        }
        uint256 recorded = settlementActualOutput[intentId];
        if (recorded >= bid.outputAmount) {
            revert IntentSettlementErrors.NoOverpromiseToSlash(recorded, bid.outputAmount);
        }
        uint256 shortfall = bid.outputAmount - recorded;
        uint256 minShortfall = (bid.outputAmount * MIN_OVERPROMISE_BPS) / BPS_DENOMINATOR;
        if (shortfall < minShortfall) {
            revert IntentSettlementErrors.OverpromiseTooSmall(shortfall, minShortfall);
        }

        slashedForOverpromise[intentId] = true;
        registry.slashOverpromise(bid.solver);
        delete settlementActualOutput[intentId];
        delete settlementRecordedAt[intentId];
    }

    /**
     * @notice Reclaim storage after the slash window when no overpromise slash occurred.
     * @dev Permissionless. Cannot prune while slash dispute data may still be needed.
     */
    function pruneSettlementRecord(bytes32 intentId) external {
        if (!settled[intentId]) revert IntentSettlementErrors.IntentNotSettled(intentId);
        if (slashedForOverpromise[intentId]) revert IntentSettlementErrors.AlreadySlashed(intentId);
        uint64 recordedAt = settlementRecordedAt[intentId];
        if (recordedAt == 0) revert IntentSettlementErrors.NoSettlementRecord(intentId);
        uint64 pruneAfter = recordedAt + SLASH_WINDOW;
        if (block.timestamp < pruneAfter) {
            revert IntentSettlementErrors.SlashWindowOpen(pruneAfter, block.timestamp);
        }

        delete settlementActualOutput[intentId];
        delete settlementRecordedAt[intentId];
        emit SettlementRecordPruned(intentId);
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    function _requireIntentWellFormed(IntentTypes.Intent calldata intent) private pure {
        if (intent.user == address(0)) revert IntentSettlementErrors.ZeroUser();
        if (intent.inputToken == address(0) || intent.outputToken == address(0)) {
            revert IntentSettlementErrors.ERC20TokensOnly();
        }
        if (intent.recipient == address(0)) revert IntentSettlementErrors.ZeroRecipient();
        if (intent.inputAmount == 0) revert IntentSettlementErrors.ZeroInputAmount();
        if (intent.minOutputAmount == 0) revert IntentSettlementErrors.ZeroMinOutput();
    }

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

    function _domainHash(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    function _recoverSigner(bytes32 digest, bytes calldata sig) private pure returns (address recovered) {
        ECDSA.RecoverError err;
        (recovered, err,) = ECDSA.tryRecover(digest, sig);
        if (err != ECDSA.RecoverError.NoError) return address(0);
    }

    function _requireIntentSignature(bytes32 digest, bytes calldata sig, address expected) private pure {
        address recovered = _recoverSigner(digest, sig);
        if (recovered != expected) {
            revert IntentSettlementErrors.InvalidIntentSignature(recovered, expected);
        }
    }

    function _requireBidSignature(bytes32 digest, bytes calldata sig, address expected) private pure {
        address recovered = _recoverSigner(digest, sig);
        if (recovered != expected) {
            revert IntentSettlementErrors.InvalidBidSignature(recovered, expected);
        }
    }
}
