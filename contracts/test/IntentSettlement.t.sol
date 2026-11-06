// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import "forge-std/Test.sol";
import "../src/IntentTypes.sol";
import "../src/SolverRegistry.sol";
import "../src/IntentSettlement.sol";

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

// Input token that tries to re-enter settle() from inside transferFrom.
contract CallbackReenterSettleToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    IntentSettlement settlement;
    IntentTypes.Intent intent;
    bytes intentSig;
    IntentTypes.Bid bid;
    bytes bidSig;
    bool armed;
    bool public reentrancyBlocked;

    function mint(address to, uint256 amt) external { balanceOf[to] += amt; }

    function approve(address sp, uint256 amt) external returns (bool) {
        allowance[msg.sender][sp] = amt;
        return true;
    }

    function arm(
        IntentSettlement s,
        IntentTypes.Intent calldata i,
        bytes calldata iSig,
        IntentTypes.Bid calldata b,
        bytes calldata bSig
    ) external {
        settlement = s;
        intent = i;
        intentSig = iSig;
        bid = b;
        bidSig = bSig;
        armed = true;
    }

    function transfer(address to, uint256 amt) external returns (bool) {
        require(balanceOf[msg.sender] >= amt);
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        return true;
    }

    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        if (armed) {
            armed = false;
            try settlement.settle(intent, intentSig, bid, bidSig) {
                reentrancyBlocked = false;
            } catch {
                reentrancyBlocked = true;
            }
        }
        require(allowance[from][msg.sender] >= amt, "allowance");
        require(balanceOf[from] >= amt, "balance");
        allowance[from][msg.sender] -= amt;
        balanceOf[from] -= amt;
        balanceOf[to] += amt;
        return true;
    }
}

// Solver contract whose receive() always reverts.
contract RevertingSolver {
    receive() external payable {
        revert("Reject ETH");
    }
}

// SwapRouter stub — mints output to recipient (simulates swap); returns fixedOutput if set, else min + 10%
contract MockSwapRouter {
    uint256 public fixedOutput;
    uint256 public lastAmountOutMinimum;

    function setFixedOutput(uint256 out) external {
        fixedOutput = out;
    }

    function exactInput(ISwapRouterTest.ExactInputParams calldata p)
        external
        payable
        returns (uint256)
    {
        require(p.path.length >= 43, "path");
        lastAmountOutMinimum = p.amountOutMinimum;
        uint256 out = fixedOutput > 0 ? fixedOutput : (p.amountOutMinimum * 110 / 100);
        address tokenOut = address(uint160(bytes20(p.path[p.path.length - 20:])));
        MockERC20(tokenOut).mint(p.recipient, out);
        return out;
    }
}

contract IntentSettlementTest is Test {
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
        uint64 n = vm.getNonce(address(this));
        address predictedSettlement = vm.computeCreateAddress(address(this), uint256(n) + 1);
        registry = new SolverRegistry(predictedSettlement, treasury);
        settlement = new IntentSettlement(address(registry));
        assertEq(address(settlement), predictedSettlement);

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

        vm.prank(solver);
        vm.expectRevert("Intent expired");
        settlement.settle(intent, iSig, bid, bSig);
    }

    function test_CannotSettleWithUnregisteredSolver() public {
        IntentTypes.Intent memory intent = _makeIntent();
        bytes memory iSig = _signIntent(intent, userPK);
        IntentTypes.Bid memory bid = _makeBid(intent, settlement.DOMAIN_SEPARATOR());
        bytes memory bSig = _signBid(bid, solverPK);

        address rando = makeAddr("rando");
        vm.prank(rando);
        vm.expectRevert("Solver not registered");
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

        vm.prank(solver);
        vm.expectRevert("Bid extends past intent");
        settlement.settle(intent, iSig, bid, bSig);
    }

    function test_RevertIfNativeInputToken() public {
        IntentTypes.Intent memory intent = _makeIntent();
        intent.inputToken = address(0);
        bytes memory iSig = _signIntent(intent, userPK);
        IntentTypes.Bid memory bid = _makeBid(intent, settlement.DOMAIN_SEPARATOR());
        bytes memory bSig = _signBid(bid, solverPK);

        vm.prank(solver);
        vm.expectRevert("ERC20 only");
        settlement.settle(intent, iSig, bid, bSig);
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

        vm.prank(solver);
        vm.expectRevert("Intent already settled");
        settlement.settle(intent, iSig, bid, bSig);
    }

    function test_SolverDeregister() public {
        uint256 balBefore = solver.balance;
        uint256 staked = registry.stake(solver);
        vm.prank(solver);
        registry.deregister();
        assertFalse(registry.isRegistered(solver));
        assertEq(registry.peerIdToAddress("12D3KooWTestPeerId"), address(0));
        assertEq(registry.pendingWithdrawals(solver), staked);

        vm.prank(solver);
        registry.withdraw();
        assertEq(registry.pendingWithdrawals(solver), 0);
        assertEq(solver.balance - balBefore, staked, "Stake not returned");
    }

    function test_SolverDeregister_RevertingReceiverCanExit() public {
        RevertingSolver badSolver = new RevertingSolver();
        uint256 minStake = registry.MIN_STAKE();
        vm.deal(address(badSolver), minStake);

        vm.prank(address(badSolver));
        registry.register{value: minStake}("12D3KooWRevertingPeer", 0);
        assertTrue(registry.isRegistered(address(badSolver)));

        vm.prank(address(badSolver));
        registry.deregister();

        assertFalse(registry.isRegistered(address(badSolver)));
        assertEq(registry.peerIdToAddress("12D3KooWRevertingPeer"), address(0));
        assertEq(registry.pendingWithdrawals(address(badSolver)), minStake);

        vm.prank(address(badSolver));
        vm.expectRevert("ETH transfer failed");
        registry.withdraw();
        assertEq(registry.pendingWithdrawals(address(badSolver)), minStake);
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

        vm.prank(solver);
        vm.expectRevert("Not preferred solver");
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

        vm.prank(solver);
        vm.expectRevert("Tier mismatch");
        settlement.settle(intent, iSig, bid, bSig);
    }

    function test_SettleEnforcesBidOutputMinimumOnRouter() public {
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

        assertEq(MockSwapRouter(settlement.SWAP_ROUTER()).lastAmountOutMinimum(), bid.outputAmount);
    }

    function test_RevertIfSwapOutputBelowBid() public {
        vm.etch(settlement.SWAP_ROUTER(), address(new MockSwapRouter()).code);

        IntentTypes.Intent memory intent = _makeIntent();
        vm.prank(user);
        usdc.approve(address(settlement), intent.inputAmount);

        bytes memory iSig = _signIntent(intent, userPK);
        IntentTypes.Bid memory bid = _makeBid(intent, settlement.DOMAIN_SEPARATOR());
        bid.outputAmount = 500_000_000_000_000_000;
        bytes memory bSig = _signBid(bid, solverPK);

        // Router returns 0.45 WETH: above intent.minOutputAmount (0.40 WETH) but below bid.outputAmount (0.50 WETH)
        MockSwapRouter(settlement.SWAP_ROUTER()).setFixedOutput(450_000_000_000_000_000);

        vm.prank(solver);
        vm.expectRevert("Output below bid");
        settlement.settle(intent, iSig, bid, bSig);

        // Failed quote must not consume user's intent nonce or mark settled
        assertEq(settlement.nonces(user), 0);
        bytes32 intentId = keccak256(
            abi.encodePacked("\x19\x01", settlement.DOMAIN_SEPARATOR(), IntentTypes.hashIntent(intent))
        );
        assertFalse(settlement.settled(intentId));
    }

    function test_CallbackTokenCannotReenterSettle() public {
        vm.etch(settlement.SWAP_ROUTER(), address(new MockSwapRouter()).code);

        CallbackReenterSettleToken input = new CallbackReenterSettleToken();
        input.mint(user, 2_000_000_000);

        IntentTypes.Intent memory intent = _makeIntent();
        intent.inputToken = address(input);

        vm.prank(user);
        input.approve(address(settlement), intent.inputAmount * 2);

        bytes memory iSig = _signIntent(intent, userPK);
        IntentTypes.Bid memory bid = _makeBid(intent, settlement.DOMAIN_SEPARATOR());
        bid.outputAmount = 500_000_000_000_000_000;
        bytes memory bSig = _signBid(bid, solverPK);
        input.arm(settlement, intent, iSig, bid, bSig);

        vm.prank(solver);
        settlement.settle(intent, iSig, bid, bSig);

        assertTrue(input.reentrancyBlocked());
        assertEq(settlement.nonces(user), 1);
    }

    // ── Helpers ───────────────────────────────────────────────────────────

    // ── Nonce passthrough tests ───────────────────────────────────────────

    function test_NoncePassthroughMatchesRegistry() public view {
        assertEq(settlement.nonces(user), registry.nonces(user));
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

        vm.prank(solver);
        vm.expectRevert("Nonce mismatch");
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
        vm.expectRevert(abi.encodeWithSelector(IntentSettlement.InvalidRouteLength.selector, bid.route.length));
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
                IntentSettlement.RouteInputTokenMismatch.selector,
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
                IntentSettlement.RouteOutputTokenMismatch.selector,
                wrongToken,
                intent.outputToken
            )
        );
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
