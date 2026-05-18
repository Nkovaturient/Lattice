// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import "forge-std/Test.sol";
import "../src/IntentTypes.sol";
import "../src/SolverRegistry.sol";
import "../src/IntentSettlement.sol";
import "../src/IntentSettlementErrors.sol";
import "../src/UniswapV3Route.sol";
import "../script/LatticeDeployLib.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

// Minimal ERC20 for test
contract MockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    string public name; uint8 public decimals;

    constructor(string memory _name, uint8 _dec) { name = _name; decimals = _dec; }

    function mint(address to, uint256 amt) external { balanceOf[to] += amt; }
    function approve(address sp, uint256 amt) external returns (bool) {
        allowance[msg.sender][sp] = amt; return true;
    }
    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        require(allowance[from][msg.sender] >= amt, "allowance");
        require(balanceOf[from] >= amt, "balance");
        allowance[from][msg.sender] -= amt;
        balanceOf[from] -= amt; balanceOf[to] += amt; return true;
    }
    function transfer(address to, uint256 amt) external returns (bool) {
        require(balanceOf[msg.sender] >= amt); balanceOf[msg.sender] -= amt; balanceOf[to] += amt; return true;
    }
}

interface ISwapRouterTest {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }
}

// SwapRouter stub — mints output to recipient (simulates swap); returns min + 10%
contract MockSwapRouter {
    function exactInput(ISwapRouterTest.ExactInputParams calldata p)
        external
        payable
        returns (uint256)
    {
        require(p.path.length >= 43, "path");
        uint256 out = p.amountOutMinimum * 110 / 100;
        address tokenOut = address(uint160(bytes20(p.path[p.path.length - 20:])));
        MockERC20(tokenOut).mint(p.recipient, out);
        return out;
    }
}

contract IntentSettlementTest is Test {
    event IntentExpired(bytes32 indexed intentId);
    event SettlementRecordPruned(bytes32 indexed intentId);
    event NonceIncremented(address indexed user, uint256 newNonce);

    SolverRegistry registry;
    IntentSettlement settlement;
    MockERC20 usdc;
    MockERC20 weth;

    address treasury = makeAddr("treasury");
    address user = makeAddr("user");
    address solver = makeAddr("solver");
    uint256 userPK;
    uint256 solverPK;

    function setUp() public {
        LatticeDeployLib.Pair memory pair = LatticeDeployLib.deployPair(vm, address(this), treasury);
        registry = pair.registry;
        settlement = pair.settlement;

        // Fund wallets
        (user,   userPK)   = makeAddrAndKey("user");
        (solver, solverPK) = makeAddrAndKey("solver");

        // Deploy tokens
        usdc = new MockERC20("USDC", 6);
        weth = new MockERC20("WETH", 18);

        // Mint test tokens
        usdc.mint(user,   1_000_000_000);     // 1000 USDC
        weth.mint(address(settlement), 1e18); // seed settlement with WETH

        // Register solver (tier 0 — tier 1 requires fill history)
        vm.deal(solver, 1 ether);
        vm.startPrank(solver);
        registry.register{value: registry.MIN_STAKE()}("12D3KooWTestPeerId", 0);
        vm.stopPrank();
    }

    // ── Tests ──────────────────────────────────────────────────────────────

    function test_SolverRegistration() public view {
        assertTrue(registry.isRegistered(solver));
        assertTrue(registry.isActiveAndStaked(solver));
        assertEq(registry.solverTier(solver), 0);
        assertEq(registry.peerIdToAddress("12D3KooWTestPeerId"), solver);
    }

    function test_SettleRevertsWhenPaused() public {
        vm.etch(settlement.SWAP_ROUTER(), address(new MockSwapRouter()).code);

        IntentTypes.Intent memory intent = _makeIntent();
        vm.prank(user);
        usdc.approve(address(settlement), intent.inputAmount);

        bytes memory iSig = _signIntent(intent, userPK);
        IntentTypes.Bid memory bid = _makeBid(intent, settlement.DOMAIN_SEPARATOR());
        bid.outputAmount = 500_000_000_000_000_000;
        bytes memory bSig = _signBid(bid, solverPK);

        settlement.pause();

        vm.prank(solver);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        settlement.settle(intent, iSig, bid, bSig);

        settlement.unpause();

        vm.prank(solver);
        settlement.settle(intent, iSig, bid, bSig);
    }

    function test_RevertEmptyPeerId() public {
        address phantom = makeAddr("phantom");
        vm.deal(phantom, 1 ether);
        uint256 stake = registry.MIN_STAKE();
        vm.prank(phantom);
        vm.expectRevert("Empty peerId");
        registry.register{value: stake}("", 0);
    }

    function test_NoncesStartAtZero() public view {
        assertEq(registry.nonces(user), 0);
    }

    function test_IntentTypeHash() public pure {
        bytes32 expected = 0x0d4e893b8ca2e1af73ef542e64756233b51d6ef4a450e4778c89898ceda17ece;
        assertEq(IntentTypes.INTENT_TYPEHASH, expected, "INTENT_TYPEHASH mismatch");
    }

    function test_BidTypeHash() public pure {
        bytes32 expected = 0x2e1aa209d8a4134c9a8e7fe708d82167eaf3ac87abb2c5a79b7dae3708aec2e7;
        assertEq(IntentTypes.BID_TYPEHASH, expected, "BID_TYPEHASH mismatch");
    }

    function test_HashIntentDeterministic() public view {
        IntentTypes.Intent memory i = _makeIntent();
        bytes32 h1 = IntentTypes.hashIntent(i);
        bytes32 h2 = IntentTypes.hashIntent(i);
        assertEq(h1, h2, "hashIntent not deterministic");
        assertTrue(h1 != bytes32(0), "hashIntent returned zero");
    }

    function test_CannotSettleExpiredIntent() public {
        IntentTypes.Intent memory intent = _makeIntent();
        intent.deadline = uint64(block.timestamp - 1); // already expired

        vm.prank(user);
        usdc.approve(address(settlement), intent.inputAmount);

        bytes memory iSig = _signIntent(intent, userPK);
        IntentTypes.Bid memory bid = _makeBid(intent, settlement.DOMAIN_SEPARATOR());
        bytes memory bSig = _signBid(bid, solverPK);

        vm.expectRevert(
            abi.encodeWithSelector(
                IntentSettlementErrors.IntentPastDeadline.selector,
                intent.deadline,
                block.timestamp
            )
        );
        vm.prank(solver);
        settlement.settle(intent, iSig, bid, bSig);
    }

    function test_CannotSettleWithUnregisteredSolver() public {
        IntentTypes.Intent memory intent = _makeIntent();
        bytes memory iSig = _signIntent(intent, userPK);
        IntentTypes.Bid memory bid = _makeBid(intent, settlement.DOMAIN_SEPARATOR());
        bytes memory bSig = _signBid(bid, solverPK);

        address rando = makeAddr("rando");
        vm.expectRevert(
            abi.encodeWithSelector(IntentSettlementErrors.SolverNotRegistered.selector, rando)
        );
        vm.prank(rando);
        settlement.settle(intent, iSig, bid, bSig);
    }

    function test_RevertIfBidDeadlinePastIntent() public {
        IntentTypes.Intent memory intent = _makeIntent();
        IntentTypes.Bid memory bid = _makeBid(intent, settlement.DOMAIN_SEPARATOR());
        bid.deadline = intent.deadline + 1;
        bytes memory bSig = _signBid(bid, solverPK);

        vm.prank(user);
        usdc.approve(address(settlement), intent.inputAmount);
        bytes memory iSig = _signIntent(intent, userPK);

        vm.expectRevert(
            abi.encodeWithSelector(
                IntentSettlementErrors.BidExceedsIntentDeadline.selector,
                bid.deadline,
                intent.deadline
            )
        );
        vm.prank(solver);
        settlement.settle(intent, iSig, bid, bSig);
    }

    function test_RevertIfNativeInputToken() public {
        IntentTypes.Intent memory intent = _makeIntent();
        intent.inputToken = address(0);
        bytes memory iSig = _signIntent(intent, userPK);
        IntentTypes.Bid memory bid = _makeBid(intent, settlement.DOMAIN_SEPARATOR());
        bytes memory bSig = _signBid(bid, solverPK);

        vm.expectRevert(IntentSettlementErrors.ERC20TokensOnly.selector);
        vm.prank(solver);
        settlement.settle(intent, iSig, bid, bSig);
    }

    function test_RevertZeroUser() public {
        IntentTypes.Intent memory intent = _makeIntent();
        intent.user = address(0);
        bytes memory iSig = abi.encodePacked(bytes32(0), bytes32(0), uint8(27));
        IntentTypes.Bid memory bid = _makeBid(intent, settlement.DOMAIN_SEPARATOR());
        bytes memory bSig = _signBid(bid, solverPK);

        vm.expectRevert(IntentSettlementErrors.ZeroUser.selector);
        vm.prank(solver);
        settlement.settle(intent, iSig, bid, bSig);
    }

    function test_RevertZeroRecipient() public {
        IntentTypes.Intent memory intent = _makeIntent();
        intent.recipient = address(0);
        _expectSettleRevert(intent, IntentSettlementErrors.ZeroRecipient.selector);
    }

    function test_RevertZeroInputAmount() public {
        IntentTypes.Intent memory intent = _makeIntent();
        intent.inputAmount = 0;
        _expectSettleRevert(intent, IntentSettlementErrors.ZeroInputAmount.selector);
    }

    function test_RevertZeroMinOutput() public {
        IntentTypes.Intent memory intent = _makeIntent();
        intent.minOutputAmount = 0;
        _expectSettleRevert(intent, IntentSettlementErrors.ZeroMinOutput.selector);
    }

    function test_MarkExpiredEmitsAndTombstones() public {
        IntentTypes.Intent memory intent = _makeIntent();
        intent.deadline = uint64(block.timestamp - 1);
        bytes memory iSig = _signIntent(intent, userPK);
        bytes32 intentId = keccak256(
            abi.encodePacked("\x19\x01", settlement.DOMAIN_SEPARATOR(), IntentTypes.hashIntent(intent))
        );
        uint256 nonceBefore = settlement.nonces(user);

        vm.expectEmit(true, false, false, true);
        emit IntentExpired(intentId);
        settlement.markExpired(intent, iSig);

        assertTrue(settlement.settled(intentId));
        assertEq(settlement.nonces(user), nonceBefore);

        vm.prank(user);
        usdc.approve(address(settlement), intent.inputAmount);
        IntentTypes.Bid memory bid = _makeBid(intent, settlement.DOMAIN_SEPARATOR());
        bid.outputAmount = intent.minOutputAmount + 1;
        bytes memory bSig = _signBid(bid, solverPK);

        vm.expectRevert(
            abi.encodeWithSelector(IntentSettlementErrors.IntentAlreadySettled.selector, intentId)
        );
        vm.prank(solver);
        settlement.settle(intent, iSig, bid, bSig);
    }

    function test_CannotMarkExpiredBeforeDeadline() public {
        IntentTypes.Intent memory intent = _makeIntent();
        bytes memory iSig = _signIntent(intent, userPK);
        vm.expectRevert(
            abi.encodeWithSelector(
                IntentSettlementErrors.IntentDeadlineNotPassed.selector,
                intent.deadline,
                block.timestamp
            )
        );
        settlement.markExpired(intent, iSig);
    }

    function test_SweepSlashedFunds_OnlyTreasury() public {
        vm.prank(solver);
        vm.expectRevert("Only treasury");
        registry.sweepSlashedFunds();
    }

    function test_CannotSettleTwice() public {
        vm.etch(settlement.SWAP_ROUTER(), address(new MockSwapRouter()).code);

        IntentTypes.Intent memory intent = _makeIntent();
        vm.prank(user);
        usdc.approve(address(settlement), intent.inputAmount);

        bytes memory iSig = _signIntent(intent, userPK);
        IntentTypes.Bid memory bid = _makeBid(intent, settlement.DOMAIN_SEPARATOR());
        bid.outputAmount = 500_000_000_000_000_000;
        bytes memory bSig = _signBid(bid, solverPK);

        vm.prank(solver);
        settlement.settle(intent, iSig, bid, bSig);

        bytes32 intentId = keccak256(
            abi.encodePacked("\x19\x01", settlement.DOMAIN_SEPARATOR(), IntentTypes.hashIntent(intent))
        );
        vm.expectRevert(
            abi.encodeWithSelector(IntentSettlementErrors.IntentAlreadySettled.selector, intentId)
        );
        vm.prank(solver);
        settlement.settle(intent, iSig, bid, bSig);
    }

    function test_SolverSlash() public {
        uint256 stakeBefore = registry.stake(solver);
        uint256 balBefore = solver.balance;
        vm.prank(address(settlement));
        registry.slash(solver, "overpromise");
        // Tier-0 min 0.05 ETH; after 0.01 slash, 0.04 < 0.05 → auto-deregister + residual returned
        assertFalse(registry.isRegistered(solver));
        assertEq(registry.stake(solver), 0);
        assertEq(stakeBefore - registry.SLASH_AMOUNT(), solver.balance - balBefore);
        assertEq(registry.slashProceedsBalance(), registry.SLASH_AMOUNT());
        uint256 tBefore = treasury.balance;
        vm.prank(treasury);
        registry.sweepSlashedFunds();
        assertEq(treasury.balance - tBefore, registry.SLASH_AMOUNT());
        assertEq(registry.slashProceedsBalance(), 0);
    }

    function test_RevertDeregisterBeforeTimelock() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                SolverRegistry.DeregisterTimelock.selector,
                uint64(block.timestamp),
                uint64(block.timestamp + registry.DEREGISTER_DELAY())
            )
        );
        vm.prank(solver);
        registry.deregister();
    }

    function test_SolverDeregister() public {
        vm.warp(block.timestamp + registry.DEREGISTER_DELAY() + 1);
        uint256 balBefore = solver.balance;
        vm.prank(solver);
        registry.deregister();
        assertFalse(registry.isRegistered(solver));
        assertGt(solver.balance, balBefore, "Stake not returned");
        assertEq(registry.peerIdToAddress("12D3KooWTestPeerId"), address(0));
    }

    function test_RecordFillExtendsDeregisterTimelock() public {
        vm.etch(settlement.SWAP_ROUTER(), address(new MockSwapRouter()).code);
        vm.warp(block.timestamp + registry.DEREGISTER_DELAY() + 1);

        IntentTypes.Intent memory intent = _makeIntent();
        vm.prank(user);
        usdc.approve(address(settlement), intent.inputAmount);
        bytes memory iSig = _signIntent(intent, userPK);
        IntentTypes.Bid memory bid = _makeBid(intent, settlement.DOMAIN_SEPARATOR());
        bid.outputAmount = 500_000_000_000_000_000;
        bytes memory bSig = _signBid(bid, solverPK);
        vm.prank(solver);
        settlement.settle(intent, iSig, bid, bSig);

        (, , , , , uint64 allowedAt,) = registry.solvers(solver);
        assertEq(allowedAt, uint64(block.timestamp + registry.DEREGISTER_DELAY()));

        vm.expectRevert(
            abi.encodeWithSelector(
                SolverRegistry.DeregisterTimelock.selector,
                uint64(block.timestamp),
                allowedAt
            )
        );
        vm.prank(solver);
        registry.deregister();
    }

    function test_FuzzIntentHash(address u, uint256 amt) public pure {
        vm.assume(u != address(0) && amt > 0 && amt < 1e30);
        IntentTypes.Intent memory i;
        i.user = u;
        i.inputAmount = amt;
        i.deadline = 9999999999;
        bytes32 h = IntentTypes.hashIntent(i);
        assertTrue(h != bytes32(0));
    }

    function test_RevertIfNotPreferredSolver() public {
        IntentTypes.Intent memory intent = _makeIntent();
        intent.preferredSolver = makeAddr("otherSolver");

        vm.prank(user);
        usdc.approve(address(settlement), intent.inputAmount);

        bytes memory iSig = _signIntent(intent, userPK);
        IntentTypes.Bid memory bid = _makeBid(intent, settlement.DOMAIN_SEPARATOR());
        bytes memory bSig = _signBid(bid, solverPK);

        vm.expectRevert(
            abi.encodeWithSelector(
                IntentSettlementErrors.NotPreferredSolver.selector,
                intent.preferredSolver,
                solver
            )
        );
        vm.prank(solver);
        settlement.settle(intent, iSig, bid, bSig);
    }

    function test_RevertIfTopicTierMismatch() public {
        IntentTypes.Intent memory intent = _makeIntent();
        intent.topicTier = 1;

        vm.prank(user);
        usdc.approve(address(settlement), intent.inputAmount);

        bytes memory iSig = _signIntent(intent, userPK);
        IntentTypes.Bid memory bid = _makeBid(intent, settlement.DOMAIN_SEPARATOR());
        bytes memory bSig = _signBid(bid, solverPK);

        vm.expectRevert(
            abi.encodeWithSelector(
                IntentSettlementErrors.SolverTierInsufficient.selector,
                uint8(0),
                uint8(1)
            )
        );
        vm.prank(solver);
        settlement.settle(intent, iSig, bid, bSig);
    }

    function test_SettleRecordsOutputAndSlashForOverpromise() public {
        vm.etch(settlement.SWAP_ROUTER(), address(new MockSwapRouter()).code);

        IntentTypes.Intent memory intent = _makeIntent();
        vm.prank(user);
        usdc.approve(address(settlement), intent.inputAmount);

        bytes memory iSig = _signIntent(intent, userPK);
        IntentTypes.Bid memory bid = _makeBid(intent, settlement.DOMAIN_SEPARATOR());
        bid.outputAmount = 500_000_000_000_000_000;
        bytes memory bSig = _signBid(bid, solverPK);

        vm.prank(solver);
        settlement.settle(intent, iSig, bid, bSig);

        bytes32 intentId = keccak256(
            abi.encodePacked("\x19\x01", settlement.DOMAIN_SEPARATOR(), IntentTypes.hashIntent(intent))
        );
        assertTrue(settlement.settled(intentId));
        uint256 recorded = settlement.settlementActualOutput(intentId);
        assertGt(recorded, 0);

        IntentTypes.Bid memory noSlashBid = _makeBid(intent, settlement.DOMAIN_SEPARATOR());
        noSlashBid.outputAmount = recorded;
        bytes memory noSlashSig = _signBid(noSlashBid, solverPK);
        vm.expectRevert(
            abi.encodeWithSelector(
                IntentSettlementErrors.NoOverpromiseToSlash.selector,
                recorded,
                recorded
            )
        );
        settlement.slashForOverpromise(noSlashBid, noSlashSig);

        IntentTypes.Bid memory slashBid = _makeBid(intent, settlement.DOMAIN_SEPARATOR());
        slashBid.outputAmount = recorded + _minSlashableShortfall(recorded);
        bytes memory slashSig = _signBid(slashBid, solverPK);

        uint256 stakeBefore = registry.stake(solver);
        settlement.slashForOverpromise(slashBid, slashSig);
        assertLt(registry.stake(solver), stakeBefore);
        assertTrue(settlement.slashedForOverpromise(intentId));
        assertEq(settlement.settlementActualOutput(intentId), 0);
        assertEq(settlement.settlementRecordedAt(intentId), 0);

        vm.expectRevert(
            abi.encodeWithSelector(IntentSettlementErrors.AlreadySlashedForOverpromise.selector, intentId)
        );
        settlement.slashForOverpromise(slashBid, slashSig);
    }

    function test_PruneSettlementRecordAfterSlashWindow() public {
        vm.etch(settlement.SWAP_ROUTER(), address(new MockSwapRouter()).code);

        IntentTypes.Intent memory intent = _makeIntent();
        vm.prank(user);
        usdc.approve(address(settlement), intent.inputAmount);

        bytes memory iSig = _signIntent(intent, userPK);
        IntentTypes.Bid memory bid = _makeBid(intent, settlement.DOMAIN_SEPARATOR());
        bid.outputAmount = 500_000_000_000_000_000;
        bytes memory bSig = _signBid(bid, solverPK);

        vm.prank(solver);
        settlement.settle(intent, iSig, bid, bSig);

        bytes32 intentId = keccak256(
            abi.encodePacked("\x19\x01", settlement.DOMAIN_SEPARATOR(), IntentTypes.hashIntent(intent))
        );
        assertGt(settlement.settlementActualOutput(intentId), 0);

        uint64 pruneAfter = uint64(block.timestamp + settlement.SLASH_WINDOW());
        vm.expectRevert(
            abi.encodeWithSelector(
                IntentSettlementErrors.SlashWindowOpen.selector,
                pruneAfter,
                uint256(block.timestamp)
            )
        );
        settlement.pruneSettlementRecord(intentId);

        vm.warp(block.timestamp + settlement.SLASH_WINDOW() + 1);

        settlement.pruneSettlementRecord(intentId);

        assertEq(settlement.settlementActualOutput(intentId), 0);
        assertEq(settlement.settlementRecordedAt(intentId), 0);
    }

    function test_SlashForOverpromise_RevertDustOverpromise() public {
        vm.etch(settlement.SWAP_ROUTER(), address(new MockSwapRouter()).code);

        IntentTypes.Intent memory intent = _makeIntent();
        vm.prank(user);
        usdc.approve(address(settlement), intent.inputAmount);

        bytes memory iSig = _signIntent(intent, userPK);
        IntentTypes.Bid memory bid = _makeBid(intent, settlement.DOMAIN_SEPARATOR());
        bid.outputAmount = 500_000_000_000_000_000;
        bytes memory bSig = _signBid(bid, solverPK);

        vm.prank(solver);
        settlement.settle(intent, iSig, bid, bSig);

        uint256 recorded = settlement.settlementActualOutput(
            keccak256(
                abi.encodePacked("\x19\x01", settlement.DOMAIN_SEPARATOR(), IntentTypes.hashIntent(intent))
            )
        );

        IntentTypes.Bid memory dustBid = _makeBid(intent, settlement.DOMAIN_SEPARATOR());
        dustBid.outputAmount = recorded + 1;
        bytes memory dustSig = _signBid(dustBid, solverPK);

        uint256 minShortfall = (dustBid.outputAmount * settlement.MIN_OVERPROMISE_BPS()) / settlement.BPS_DENOMINATOR();
        vm.expectRevert(
            abi.encodeWithSelector(IntentSettlementErrors.OverpromiseTooSmall.selector, uint256(1), minShortfall)
        );
        settlement.slashForOverpromise(dustBid, dustSig);
    }

    function test_SlashForOverpromise_AfterPriorSlashAutoDeregister() public {
        vm.etch(settlement.SWAP_ROUTER(), address(new MockSwapRouter()).code);

        IntentTypes.Intent memory intent = _makeIntent();
        vm.prank(user);
        usdc.approve(address(settlement), intent.inputAmount);

        bytes memory iSig = _signIntent(intent, userPK);
        IntentTypes.Bid memory bid = _makeBid(intent, settlement.DOMAIN_SEPARATOR());
        bid.outputAmount = 500_000_000_000_000_000;
        bytes memory bSig = _signBid(bid, solverPK);

        vm.prank(solver);
        settlement.settle(intent, iSig, bid, bSig);

        uint256 recorded = settlement.settlementActualOutput(
            keccak256(
                abi.encodePacked("\x19\x01", settlement.DOMAIN_SEPARATOR(), IntentTypes.hashIntent(intent))
            )
        );

        vm.prank(address(settlement));
        registry.slash(solver, "prior");
        assertFalse(registry.isRegistered(solver));

        (, , , , uint256 slashesAfterPrior,,) = registry.solvers(solver);
        assertEq(slashesAfterPrior, 1);

        uint256 proceedsBefore = registry.slashProceedsBalance();

        IntentTypes.Bid memory slashBid = _makeBid(intent, settlement.DOMAIN_SEPARATOR());
        slashBid.outputAmount = recorded + _minSlashableShortfall(recorded);
        bytes memory slashSig = _signBid(slashBid, solverPK);

        settlement.slashForOverpromise(slashBid, slashSig);

        (, , , , uint256 slashesAfterOverpromise,,) = registry.solvers(solver);
        assertEq(slashesAfterOverpromise, slashesAfterPrior + 1);
        assertEq(registry.slashProceedsBalance(), proceedsBefore);
    }

    function test_SlashOverpromise_RevertNoSolverHistory() public {
        vm.prank(address(settlement));
        vm.expectRevert("No solver history");
        registry.slashOverpromise(makeAddr("random"));
    }

    // ── Helpers ───────────────────────────────────────────────────────────

    // ── Nonce passthrough tests ───────────────────────────────────────────

    function test_NoncePassthroughMatchesRegistry() public view {
        assertEq(settlement.nonces(user), registry.nonces(user));
    }

    function test_NonceIncrementEmitsEvent() public {
        vm.etch(settlement.SWAP_ROUTER(), address(new MockSwapRouter()).code);

        IntentTypes.Intent memory intent = _makeIntent();
        vm.prank(user);
        usdc.approve(address(settlement), intent.inputAmount);

        bytes memory iSig = _signIntent(intent, userPK);
        IntentTypes.Bid memory bid = _makeBid(intent, settlement.DOMAIN_SEPARATOR());
        bid.outputAmount = 500_000_000_000_000_000;
        bytes memory bSig = _signBid(bid, solverPK);

        vm.expectEmit(true, false, false, true);
        emit NonceIncremented(user, 1);
        vm.prank(solver);
        settlement.settle(intent, iSig, bid, bSig);
    }

    function test_NonceIncrementAfterSettle() public {
        vm.etch(settlement.SWAP_ROUTER(), address(new MockSwapRouter()).code);

        IntentTypes.Intent memory intent = _makeIntent();
        vm.prank(user);
        usdc.approve(address(settlement), intent.inputAmount);

        bytes memory iSig = _signIntent(intent, userPK);
        IntentTypes.Bid memory bid = _makeBid(intent, settlement.DOMAIN_SEPARATOR());
        bid.outputAmount = 500_000_000_000_000_000;
        bytes memory bSig = _signBid(bid, solverPK);

        assertEq(settlement.nonces(user), 0);

        vm.prank(solver);
        settlement.settle(intent, iSig, bid, bSig);

        assertEq(settlement.nonces(user), 1);
        assertEq(settlement.nonces(user), registry.nonces(user));
    }

    function test_RevertNonceMismatch() public {
        IntentTypes.Intent memory intent = _makeIntent();
        intent.nonce = 999; // wrong nonce

        vm.prank(user);
        usdc.approve(address(settlement), intent.inputAmount);

        bytes memory iSig = _signIntent(intent, userPK);
        IntentTypes.Bid memory bid = _makeBid(intent, settlement.DOMAIN_SEPARATOR());
        bytes memory bSig = _signBid(bid, solverPK);

        vm.expectRevert(
            abi.encodeWithSelector(
                IntentSettlementErrors.NonceMismatch.selector,
                registry.nonces(user),
                intent.nonce
            )
        );
        vm.prank(solver);
        settlement.settle(intent, iSig, bid, bSig);
    }

    // ── Route validation custom error tests ───────────────────────────────

    function test_RevertInvalidRouteLength() public {
        IntentTypes.Intent memory intent = _makeIntent();
        vm.prank(user);
        usdc.approve(address(settlement), intent.inputAmount);

        bytes memory iSig = _signIntent(intent, userPK);

        IntentTypes.Bid memory bid = _makeBid(intent, settlement.DOMAIN_SEPARATOR());
        bid.route = abi.encodePacked(intent.inputToken, uint24(3000)); // 23 bytes — invalid
        bytes memory bSig = _signBid(bid, solverPK);

        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(UniswapV3Route.InvalidRouteLength.selector, bid.route.length));
        settlement.settle(intent, iSig, bid, bSig);
    }

    function test_RevertRouteInputTokenMismatch() public {
        IntentTypes.Intent memory intent = _makeIntent();
        vm.prank(user);
        usdc.approve(address(settlement), intent.inputAmount);

        bytes memory iSig = _signIntent(intent, userPK);

        address wrongToken = makeAddr("wrongIn");
        IntentTypes.Bid memory bid = _makeBid(intent, settlement.DOMAIN_SEPARATOR());
        bid.route = abi.encodePacked(wrongToken, uint24(3000), intent.outputToken);
        bytes memory bSig = _signBid(bid, solverPK);

        vm.prank(solver);
        vm.expectRevert(
            abi.encodeWithSelector(
                UniswapV3Route.RouteInputTokenMismatch.selector,
                wrongToken,
                intent.inputToken
            )
        );
        settlement.settle(intent, iSig, bid, bSig);
    }

    function test_RevertRouteOutputTokenMismatch() public {
        IntentTypes.Intent memory intent = _makeIntent();
        vm.prank(user);
        usdc.approve(address(settlement), intent.inputAmount);

        bytes memory iSig = _signIntent(intent, userPK);

        address wrongToken = makeAddr("wrongOut");
        IntentTypes.Bid memory bid = _makeBid(intent, settlement.DOMAIN_SEPARATOR());
        bid.route = abi.encodePacked(intent.inputToken, uint24(3000), wrongToken);
        bytes memory bSig = _signBid(bid, solverPK);

        vm.prank(solver);
        vm.expectRevert(
            abi.encodeWithSelector(
                UniswapV3Route.RouteOutputTokenMismatch.selector,
                wrongToken,
                intent.outputToken
            )
        );
        settlement.settle(intent, iSig, bid, bSig);
    }

    function test_RevertRouteZeroHopToken() public {
        IntentTypes.Intent memory intent = _makeIntent();
        vm.prank(user);
        usdc.approve(address(settlement), intent.inputAmount);

        bytes memory iSig = _signIntent(intent, userPK);
        IntentTypes.Bid memory bid = _makeBid(intent, settlement.DOMAIN_SEPARATOR());
        bid.route = abi.encodePacked(intent.inputToken, uint24(3000), address(0), uint24(3000), intent.outputToken);
        bytes memory bSig = _signBid(bid, solverPK);

        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(UniswapV3Route.RouteZeroHopToken.selector, uint256(23)));
        settlement.settle(intent, iSig, bid, bSig);
    }

    function test_RevertInvalidRouteFee() public {
        IntentTypes.Intent memory intent = _makeIntent();
        vm.prank(user);
        usdc.approve(address(settlement), intent.inputAmount);

        bytes memory iSig = _signIntent(intent, userPK);
        IntentTypes.Bid memory bid = _makeBid(intent, settlement.DOMAIN_SEPARATOR());
        bid.route = abi.encodePacked(intent.inputToken, uint24(2500), intent.outputToken);
        bytes memory bSig = _signBid(bid, solverPK);

        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(UniswapV3Route.InvalidRouteFee.selector, uint24(2500)));
        settlement.settle(intent, iSig, bid, bSig);
    }

    function test_TwoHopRouteValid() public {
        vm.etch(settlement.SWAP_ROUTER(), address(new MockSwapRouter()).code);

        address bridgeToken = makeAddr("bridge");
        // 66-byte two-hop path (43 + 23)
        IntentTypes.Intent memory intent = _makeIntent();
        vm.prank(user);
        usdc.approve(address(settlement), intent.inputAmount);

        bytes memory iSig = _signIntent(intent, userPK);
        IntentTypes.Bid memory bid = _makeBid(intent, settlement.DOMAIN_SEPARATOR());
        bid.route = abi.encodePacked(intent.inputToken, uint24(500), bridgeToken, uint24(3000), intent.outputToken);
        bid.outputAmount = 500_000_000_000_000_000;
        bytes memory bSig = _signBid(bid, solverPK);

        vm.prank(solver);
        settlement.settle(intent, iSig, bid, bSig);
    }

    // ── Helpers ───────────────────────────────────────────────────────────

    function _minSlashableShortfall(uint256 recorded) internal view returns (uint256) {
        uint256 bps = settlement.MIN_OVERPROMISE_BPS();
        uint256 denom = settlement.BPS_DENOMINATOR();
        // shortfall * denom >= (recorded + shortfall) * bps  =>  shortfall >= recorded * bps / (denom - bps)
        uint256 minBpsDenom = denom - bps;
        return (recorded * bps + minBpsDenom - 1) / minBpsDenom + 1;
    }

    function _attemptSettle(IntentTypes.Intent memory intent) internal {
        vm.prank(user);
        usdc.approve(address(settlement), intent.inputAmount);
        bytes memory iSig = _signIntent(intent, userPK);
        IntentTypes.Bid memory bid = _makeBid(intent, settlement.DOMAIN_SEPARATOR());
        if (intent.minOutputAmount == 0) {
            bid.outputAmount = 1;
        } else {
            bid.outputAmount = intent.minOutputAmount + 1;
        }
        bytes memory bSig = _signBid(bid, solverPK);
        vm.prank(solver);
        settlement.settle(intent, iSig, bid, bSig);
    }

    function _expectSettleRevert(IntentTypes.Intent memory intent, bytes4 selector) internal {
        vm.prank(user);
        usdc.approve(address(settlement), intent.inputAmount);
        bytes memory iSig = _signIntent(intent, userPK);
        IntentTypes.Bid memory bid = _makeBid(intent, settlement.DOMAIN_SEPARATOR());
        if (intent.minOutputAmount == 0) {
            bid.outputAmount = 1;
        }
        bytes memory bSig = _signBid(bid, solverPK);
        vm.expectRevert(selector);
        vm.prank(solver);
        settlement.settle(intent, iSig, bid, bSig);
    }

    function _makeIntent() internal view returns (IntentTypes.Intent memory) {
        IntentTypes.Intent memory i;
        i.user            = user;
        i.nonce           = registry.nonces(user);
        i.inputToken      = address(usdc);
        i.outputToken     = address(weth);
        i.inputAmount     = 1_000_000_000;
        i.minOutputAmount = 400_000_000_000_000_000;
        i.recipient       = user;
        i.deadline        = uint64(block.timestamp + 600);
        i.topicTier       = 0;
        i.preferredSolver = address(0);
        return i;
    }

    function _makeBid(IntentTypes.Intent memory intent, bytes32 domSep)
        internal view returns (IntentTypes.Bid memory)
    {
        bytes32 intentId = keccak256(abi.encodePacked(
            "\x19\x01", domSep, IntentTypes.hashIntent(intent)
        ));
        IntentTypes.Bid memory b;
        b.intentId     = intentId;
        b.solver       = solver;
        b.outputAmount = 420_000_000_000_000_000; // 0.42 WETH
        b.route        = abi.encodePacked(intent.inputToken, uint24(3000), intent.outputToken);
        b.deadline     = intent.deadline;
        return b;
    }

    function _signIntent(IntentTypes.Intent memory i, uint256 pk)
        internal view returns (bytes memory)
    {
        bytes32 structHash = IntentTypes.hashIntent(i);
        bytes32 digest = keccak256(abi.encodePacked(
            "\x19\x01", settlement.DOMAIN_SEPARATOR(), structHash
        ));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signBid(IntentTypes.Bid memory b, uint256 pk)
        internal view returns (bytes memory)
    {
        bytes32 structHash = IntentTypes.hashBid(b);
        bytes32 digest = keccak256(abi.encodePacked(
            "\x19\x01", settlement.DOMAIN_SEPARATOR(), structHash
        ));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }
}
