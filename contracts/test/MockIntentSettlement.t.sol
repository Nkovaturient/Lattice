// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import "forge-std/Test.sol";
import "../src/SolverRegistry.sol";
import "../src/MockIntentSettlement.sol";
import "../src/IntentSettlementErrors.sol";
import "../src/UniswapV3Route.sol";

contract MockERC20M {
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
        require(balanceOf[msg.sender] >= amt);
        balanceOf[msg.sender] -= amt; balanceOf[to] += amt; return true;
    }
}

contract MockIntentSettlementTest is Test {
    SolverRegistry registry;
    MockIntentSettlement settlement;
    MockERC20M usdc;
    MockERC20M weth;

    address treasury = makeAddr("treasury");
    address user;
    address solver;
    uint256 userPK;
    uint256 solverPK;

    function setUp() public {
        uint64 n = vm.getNonce(address(this));
        address predictedSettlement = vm.computeCreateAddress(address(this), uint256(n) + 1);
        registry = new SolverRegistry(predictedSettlement, treasury);
        settlement = new MockIntentSettlement(address(registry));
        assertEq(address(settlement), predictedSettlement);

        (user,   userPK)   = makeAddrAndKey("user");
        (solver, solverPK) = makeAddrAndKey("solver");

        usdc = new MockERC20M("USDC", 6);
        weth = new MockERC20M("WETH", 18);

        usdc.mint(user, 1_000_000_000);

        vm.deal(solver, 1 ether);
        vm.startPrank(solver);
        registry.register{value: registry.MIN_STAKE()}("12D3KooWMockPeer", 0);
        vm.stopPrank();
    }

    // ── Happy path ────────────────────────────────────────────────────────

    function test_SettleHappyPath() public {
        MockIntentSettlement.Intent memory intent = _makeIntent();
        vm.prank(user);
        usdc.approve(address(settlement), intent.inputAmount);

        bytes memory iSig = _signIntent(intent);
        MockIntentSettlement.Bid memory bid = _makeBid(intent);
        bytes memory bSig = _signBid(bid);

        vm.prank(solver);
        settlement.settle(intent, iSig, bid, bSig);

        bytes32 intentId = _intentId(intent);
        assertTrue(settlement.settled(intentId));
        assertEq(settlement.nonces(user), 1);
    }

    // ── Nonce (local mapping) ─────────────────────────────────────────────

    function test_NoncesStartAtZero() public view {
        assertEq(settlement.nonces(user), 0);
    }

    function test_NonceIncrementAfterSettle() public {
        MockIntentSettlement.Intent memory intent = _makeIntent();
        vm.prank(user);
        usdc.approve(address(settlement), intent.inputAmount);

        bytes memory iSig = _signIntent(intent);
        MockIntentSettlement.Bid memory bid = _makeBid(intent);
        bytes memory bSig = _signBid(bid);

        vm.prank(solver);
        settlement.settle(intent, iSig, bid, bSig);

        assertEq(settlement.nonces(user), 1);
    }

    function test_RevertNonceMismatch() public {
        MockIntentSettlement.Intent memory intent = _makeIntent();
        intent.nonce = 999;

        vm.prank(user);
        usdc.approve(address(settlement), intent.inputAmount);

        bytes memory iSig = _signIntent(intent);
        MockIntentSettlement.Bid memory bid = _makeBid(intent);
        bytes memory bSig = _signBid(bid);

        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(IntentSettlementErrors.NonceMismatch.selector, 0, 999));
        settlement.settle(intent, iSig, bid, bSig);
    }

    // ── Replay protection ─────────────────────────────────────────────────

    function test_CannotSettleTwice() public {
        MockIntentSettlement.Intent memory intent = _makeIntent();
        vm.prank(user);
        usdc.approve(address(settlement), intent.inputAmount * 2);

        bytes memory iSig = _signIntent(intent);
        MockIntentSettlement.Bid memory bid = _makeBid(intent);
        bytes memory bSig = _signBid(bid);

        vm.prank(solver);
        settlement.settle(intent, iSig, bid, bSig);

        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(IntentSettlementErrors.IntentAlreadySettled.selector, _intentId(intent)));
        settlement.settle(intent, iSig, bid, bSig);
    }

    // ── Deadline checks ───────────────────────────────────────────────────

    function test_RevertExpiredIntent() public {
        MockIntentSettlement.Intent memory intent = _makeIntent();
        intent.deadline = uint64(block.timestamp - 1);

        vm.prank(user);
        usdc.approve(address(settlement), intent.inputAmount);

        bytes memory iSig = _signIntent(intent);
        MockIntentSettlement.Bid memory bid = _makeBid(intent);
        bytes memory bSig = _signBid(bid);

        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(IntentSettlementErrors.IntentPastDeadline.selector, intent.deadline, block.timestamp));
        settlement.settle(intent, iSig, bid, bSig);
    }

    function test_RevertBidExceedsIntentDeadline() public {
        MockIntentSettlement.Intent memory intent = _makeIntent();
        bytes memory iSig = _signIntent(intent);

        MockIntentSettlement.Bid memory bid = _makeBid(intent);
        bid.deadline = intent.deadline + 1;
        bytes memory bSig = _signBid(bid);

        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(IntentSettlementErrors.BidExceedsIntentDeadline.selector, bid.deadline, intent.deadline));
        settlement.settle(intent, iSig, bid, bSig);
    }

    function test_RevertZeroUser() public {
        MockIntentSettlement.Intent memory intent = _makeIntent();
        intent.user = address(0);
        bytes memory iSig = abi.encodePacked(bytes32(0), bytes32(0), uint8(27));
        MockIntentSettlement.Bid memory bid = _makeBid(intent);
        bytes memory bSig = _signBid(bid);

        vm.expectRevert(IntentSettlementErrors.ZeroUser.selector);
        vm.prank(solver);
        settlement.settle(intent, iSig, bid, bSig);
    }

    // ── Route validation ──────────────────────────────────────────────────

    function test_RevertRouteInvalidLength() public {
        MockIntentSettlement.Intent memory intent = _makeIntent();
        vm.prank(user);
        usdc.approve(address(settlement), intent.inputAmount);

        bytes memory iSig = _signIntent(intent);
        MockIntentSettlement.Bid memory bid = _makeBid(intent);
        bid.route = abi.encodePacked(intent.inputToken, uint24(3000)); // 23 bytes
        bytes memory bSig = _signBid(bid);

        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(UniswapV3Route.InvalidRouteLength.selector, bid.route.length));
        settlement.settle(intent, iSig, bid, bSig);
    }

    function test_RevertRouteInputTokenMismatch() public {
        MockIntentSettlement.Intent memory intent = _makeIntent();
        vm.prank(user);
        usdc.approve(address(settlement), intent.inputAmount);

        bytes memory iSig = _signIntent(intent);
        address wrongToken = makeAddr("wrongIn");
        MockIntentSettlement.Bid memory bid = _makeBid(intent);
        bid.route = abi.encodePacked(wrongToken, uint24(3000), intent.outputToken);
        bytes memory bSig = _signBid(bid);

        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(UniswapV3Route.RouteInputTokenMismatch.selector, wrongToken, intent.inputToken));
        settlement.settle(intent, iSig, bid, bSig);
    }

    function test_RevertRouteOutputTokenMismatch() public {
        MockIntentSettlement.Intent memory intent = _makeIntent();
        vm.prank(user);
        usdc.approve(address(settlement), intent.inputAmount);

        bytes memory iSig = _signIntent(intent);
        address wrongToken = makeAddr("wrongOut");
        MockIntentSettlement.Bid memory bid = _makeBid(intent);
        bid.route = abi.encodePacked(intent.inputToken, uint24(3000), wrongToken);
        bytes memory bSig = _signBid(bid);

        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(UniswapV3Route.RouteOutputTokenMismatch.selector, wrongToken, intent.outputToken));
        settlement.settle(intent, iSig, bid, bSig);
    }

    function test_RevertRouteZeroHopToken() public {
        MockIntentSettlement.Intent memory intent = _makeIntent();
        vm.prank(user);
        usdc.approve(address(settlement), intent.inputAmount);

        bytes memory iSig = _signIntent(intent);
        MockIntentSettlement.Bid memory bid = _makeBid(intent);
        bid.route = abi.encodePacked(intent.inputToken, uint24(3000), address(0), uint24(3000), intent.outputToken);
        bytes memory bSig = _signBid(bid);

        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(UniswapV3Route.RouteZeroHopToken.selector, uint256(23)));
        settlement.settle(intent, iSig, bid, bSig);
    }

    function test_RevertInvalidRouteFee() public {
        MockIntentSettlement.Intent memory intent = _makeIntent();
        vm.prank(user);
        usdc.approve(address(settlement), intent.inputAmount);

        bytes memory iSig = _signIntent(intent);
        MockIntentSettlement.Bid memory bid = _makeBid(intent);
        bid.route = abi.encodePacked(intent.inputToken, uint24(2500), intent.outputToken);
        bytes memory bSig = _signBid(bid);

        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(UniswapV3Route.InvalidRouteFee.selector, uint24(2500)));
        settlement.settle(intent, iSig, bid, bSig);
    }

    // ── Registration / tier checks ────────────────────────────────────────

    function test_RevertUnregisteredSolver() public {
        MockIntentSettlement.Intent memory intent = _makeIntent();
        bytes memory iSig = _signIntent(intent);
        MockIntentSettlement.Bid memory bid = _makeBid(intent);
        bytes memory bSig = _signBid(bid);

        vm.prank(makeAddr("rando"));
        vm.expectRevert(abi.encodeWithSelector(IntentSettlementErrors.SolverNotRegistered.selector, makeAddr("rando")));
        settlement.settle(intent, iSig, bid, bSig);
    }

    function test_RevertTierMismatch() public {
        MockIntentSettlement.Intent memory intent = _makeIntent();
        intent.topicTier = 1;

        vm.prank(user);
        usdc.approve(address(settlement), intent.inputAmount);

        bytes memory iSig = _signIntent(intent);
        MockIntentSettlement.Bid memory bid = _makeBid(intent);
        bytes memory bSig = _signBid(bid);

        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(IntentSettlementErrors.SolverTierInsufficient.selector, 0, 1));
        settlement.settle(intent, iSig, bid, bSig);
    }

    function test_RevertBidBelowFloor() public {
        MockIntentSettlement.Intent memory intent = _makeIntent();
        vm.prank(user);
        usdc.approve(address(settlement), intent.inputAmount);

        bytes memory iSig = _signIntent(intent);
        MockIntentSettlement.Bid memory bid = _makeBid(intent);
        bid.outputAmount = intent.minOutputAmount - 1;
        bytes memory bSig = _signBid(bid);

        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(IntentSettlementErrors.BidBelowFloor.selector, bid.outputAmount, intent.minOutputAmount));
        settlement.settle(intent, iSig, bid, bSig);
    }

    function test_RevertPreferredSolverBypass() public {
        address other = makeAddr("other");
        MockIntentSettlement.Intent memory intent = _makeIntent();
        intent.preferredSolver = other;

        vm.prank(user);
        usdc.approve(address(settlement), intent.inputAmount);

        bytes memory iSig = _signIntent(intent);
        MockIntentSettlement.Bid memory bid = _makeBid(intent);
        bytes memory bSig = _signBid(bid);

        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(IntentSettlementErrors.NotPreferredSolver.selector, other, solver));
        settlement.settle(intent, iSig, bid, bSig);
    }

    // ── Helpers ───────────────────────────────────────────────────────────

    function _makeIntent() internal view returns (MockIntentSettlement.Intent memory) {
        MockIntentSettlement.Intent memory i;
        i.user            = user;
        i.nonce           = settlement.nonces(user);
        i.inputToken      = address(usdc);
        i.outputToken     = address(weth);
        i.inputAmount     = 1_000_000;
        i.minOutputAmount = 400_000_000_000_000;
        i.recipient       = user;
        i.deadline        = uint64(block.timestamp + 600);
        i.topicTier       = 0;
        i.preferredSolver = address(0);
        return i;
    }

    function _makeBid(MockIntentSettlement.Intent memory intent)
        internal view returns (MockIntentSettlement.Bid memory)
    {
        bytes32 intentId = settlement.hashIntent(intent);
        MockIntentSettlement.Bid memory b;
        b.intentId     = intentId;
        b.solver       = solver;
        b.outputAmount = 420_000_000_000_000;
        b.route        = abi.encodePacked(intent.inputToken, uint24(3000), intent.outputToken);
        b.deadline     = intent.deadline;
        return b;
    }

    function _intentId(MockIntentSettlement.Intent memory intent) internal view returns (bytes32) {
        return settlement.hashIntent(intent);
    }

    function _signIntent(MockIntentSettlement.Intent memory i) internal view returns (bytes memory) {
        bytes32 digest = settlement.hashIntent(i);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPK, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signBid(MockIntentSettlement.Bid memory b) internal view returns (bytes memory) {
        bytes32 domSep = settlement.domainSeparator();
        bytes32 bidStructHash = keccak256(abi.encode(
            keccak256("Bid(bytes32 intentId,address solver,uint256 outputAmount,bytes route,uint64 deadline)"),
            b.intentId,
            b.solver,
            b.outputAmount,
            keccak256(b.route),
            b.deadline
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domSep, bidStructHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(solverPK, digest);
        return abi.encodePacked(r, s, v);
    }
}
