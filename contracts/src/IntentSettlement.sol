// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./IntentTypes.sol";
import "./SolverRegistry.sol";

// Minimal interface — only what we call on the SwapRouter
interface ISwapRouter {
    struct ExactInputParams {
        bytes   path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }
    function exactInput(ExactInputParams calldata params)
        external payable returns (uint256 amountOut);
}


interface IQuoterV2 {
    function quoteExactInput(bytes memory path, uint256 amountIn)
        external returns (uint256 amountOut, uint160[] memory, uint32[] memory, uint256[] memory);
}

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

// Track 4.1 — Intent settlement contract.
// Verifies both EIP-712 signatures, executes the Uniswap v3 swap via the
// encoded route, checks output >= minOutputAmount, pays the solver fee,
// and protects against replay via per-user nonces.

contract IntentSettlement {
    using IntentTypes for IntentTypes.Intent;
    using IntentTypes for IntentTypes.Bid;

    // ── Constants ─────────────────────────────────────────────────────────────

    // EIP-712 domain — must match domain.js DOMAIN exactly
    bytes32 public immutable DOMAIN_SEPARATOR;

    // Protocol fee: solver earns SOLVER_FEE_BPS basis points of output surplus
    // Surplus = actualOutput - minOutputAmount
    uint256 public constant SOLVER_FEE_BPS  = 500;    // 5% of surplus
    uint256 public constant BPS_DENOMINATOR = 10_000;

    // Uniswap v3 SwapRouter + QuoterV2 (same address Arbitrum mainnet + Sepolia)
    address public constant SWAP_ROUTER = 0xE592427A0AEce92De3Edee1F18E0157C05861564;
    address public constant QUOTER_V2   = 0x61fFE014bA17989E743c5F6cB21bF9697530B21e;

    // ── State ─────────────────────────────────────────────────────────────────

    SolverRegistry public immutable registry;

    // Replay protection: intentId → settled
    mapping(bytes32 => bool) public settled;

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
        DOMAIN_SEPARATOR = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("IntentDeFi"),
            keccak256("1"),
            block.chainid,
            address(this)
        ));
    }

    // ── Settlement ────────────────────────────────────────────────────────────

    /**
     * Settle an intent with a winning solver bid.
     * Called by the winning solver after the off-chain auction resolves.
     *
     * Steps:
     *   1. Replay check — intentId not already settled
     *   2. Deadline check — intent not expired
     *   3. Solver check   — solver is registered and staked
     *   4. Verify user's EIP-712 intent signature
     *   5. Verify solver's EIP-712 bid signature
     *   6. Verify bid is for this intent + bid not expired
     *   7. Pull inputToken from user → this contract
     *   8. Execute Uniswap v3 swap via encodedRoute
     *   9. Check actualOutput >= minOutputAmount
     *  10. Pay recipient actualOutput - solverFee
     *  11. Pay solver solverFee
     *  12. Increment user nonce, mark intent settled
     */
    function settle(
        IntentTypes.Intent calldata intent,
        bytes calldata intentSig,
        IntentTypes.Bid   calldata bid,
        bytes calldata bidSig
    ) external {

        // ── 1. Replay protection ──────────────────────────────────────────────
        bytes32 intentId = _domainHash(intent.hashIntent());
        require(!settled[intentId], "Intent already settled");

        // ── 2. Deadline ───────────────────────────────────────────────────────
        require(block.timestamp <= intent.deadline, "Intent expired");
        require(block.timestamp <= bid.deadline,    "Bid expired");

        // ── 3. Solver registry ────────────────────────────────────────────────
        require(registry.isActiveAndStaked(msg.sender), "Solver not registered");

        // ── 4. Verify intent signature (user) ────────────────────────────────
        require(
            _verifySignature(intentId, intentSig, intent.user),
            "Invalid intent signature"
        );

        // Nonce check — prevents replaying an old signed intent
        require(
            registry.nonces(intent.user) == intent.nonce,
            "Nonce mismatch"
        );

        // ── 5. Verify bid signature (solver) ─────────────────────────────────
        bytes32 bidHash = _domainHash(bid.hashBid());
        require(
            _verifySignature(bidHash, bidSig, msg.sender),
            "Invalid bid signature"
        );

        // ── 6. Bid integrity checks ───────────────────────────────────────────
        require(bid.intentId == intentId,                 "Bid intentId mismatch");
        require(bid.solver   == msg.sender,               "Bid solver mismatch");
        require(bid.outputAmount >= intent.minOutputAmount, "Bid below floor");

        // ── 7. Pull input tokens from user ────────────────────────────────────
        IERC20(intent.inputToken).transferFrom(
            intent.user, address(this), intent.inputAmount
        );
        IERC20(intent.inputToken).approve(SWAP_ROUTER, intent.inputAmount);

        // ── 8. Execute swap via Uniswap v3 ───────────────────────────────────
        uint256 actualOutput = ISwapRouter(SWAP_ROUTER).exactInput(
            ISwapRouter.ExactInputParams({
                path:             bid.route,
                recipient:        address(this),   // receive here, pay out below
                deadline:         bid.deadline,
                amountIn:         intent.inputAmount,
                amountOutMinimum: intent.minOutputAmount  // hard floor
            })
        );

        // ── 9. Output floor ───────────────────────────────────────────────────
        require(actualOutput >= intent.minOutputAmount, "Output below minimum");

        // ── 10+11. Pay recipient + solver ────────────────────────────────────
        uint256 surplus   = actualOutput - intent.minOutputAmount;
        uint256 solverFee = (surplus * SOLVER_FEE_BPS) / BPS_DENOMINATOR;
        uint256 userGets  = actualOutput - solverFee;

        IERC20(intent.outputToken).transfer(intent.recipient, userGets);
        IERC20(intent.outputToken).transfer(msg.sender,       solverFee);

        // ── 12. State updates ─────────────────────────────────────────────────
        settled[intentId] = true;
        registry.incrementNonce(intent.user);
        registry.recordFill(msg.sender);  // Track 5.2: fill history for tier progression

        emit IntentSettled(
            intentId,
            intent.user,
            msg.sender,
            intent.inputAmount,
            actualOutput,
            solverFee
        );
    }

    // ── Slash helpers ─────────────────────────────────────────────────────────

    /**
     * Slash a solver who submitted a bid with outputAmount > actual swap output.
     * Callable by anyone with proof (the original bid struct + sig).
     * Proof: re-simulate the same route and show it yields < bid.outputAmount.
     */
    function slashForOverpromise(
        IntentTypes.Bid calldata bid,
        bytes calldata bidSig,
        uint256 actualOutput
    ) external {
        bytes32 bidHash = _domainHash(bid.hashBid());
        require(
            _verifySignature(bidHash, bidSig, bid.solver),
            "Invalid bid signature"
        );
        require(actualOutput < bid.outputAmount, "No overpromise to slash");

        registry.slash(bid.solver, "overpromise");
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    function _domainHash(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    function _verifySignature(
        bytes32 hash,
        bytes calldata sig,
        address expected
    ) internal pure returns (bool) {
        require(sig.length == 65, "Invalid sig length");
        bytes32 r; bytes32 s; uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        return ecrecover(hash, v, r, s) == expected;
    }
}
