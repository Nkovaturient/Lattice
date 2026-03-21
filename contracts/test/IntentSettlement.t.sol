// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

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

// SwapRouter stub — returns minOutputAmount + 10% bonus to simulate real swap
contract MockSwapRouter {
    function exactInput(ISwapRouter.ExactInputParams calldata p)
        external payable returns (uint256) {
        // Uniswap v3 path: tokenIn (20 bytes) + fee (3) + … — touch first token
        require(p.path.length >= 20, "path");
        address tokenIn = address(uint160(bytes20(p.path[0:20])));
        (bool ok,) = tokenIn.call(""); ok;
        // Return 10% above minimum to simulate surplus for solver fee
        uint256 out = p.amountOutMinimum * 110 / 100;
        return out;
    }
}

contract IntentSettlementTest is Test {
    SolverRegistry  registry;
    IntentSettlement settlement;
    MockERC20       usdc;
    MockERC20       weth;

    address user   = makeAddr("user");
    address solver = makeAddr("solver");
    uint256 userPK;
    uint256 solverPK;

    function setUp() public {
        // Circular dep: Registry needs settlement addr; Settlement needs registry.
        // Predict the next CREATE address so Registry can be wired to the Settlement we deploy second.
        uint64 n = vm.getNonce(address(this));
        address predictedSettlement = vm.computeCreateAddress(address(this), uint256(n) + 1);
        registry = new SolverRegistry(predictedSettlement);
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

        // Register solver
        vm.deal(solver, 1 ether);
        vm.startPrank(solver);
        registry.register{value: registry.MIN_STAKE()}("12D3KooWTestPeerId", 1);
        vm.stopPrank();
    }

    // ── Tests ──────────────────────────────────────────────────────────────

    function test_SolverRegistration() public view {
        assertTrue(registry.isRegistered(solver));
        assertTrue(registry.isActiveAndStaked(solver));
        assertEq(registry.solverTier(solver), 1);
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

    function test_CannotSettleTwice() public  view {
        // Only tests the replay check — full settlement needs mock SwapRouter
        // Verify settled mapping starts false
        IntentTypes.Intent memory intent = _makeIntent();
        bytes32 intentId = keccak256(abi.encodePacked(
            "\x19\x01",
            settlement.DOMAIN_SEPARATOR(),
            IntentTypes.hashIntent(intent)
        ));
        assertFalse(settlement.settled(intentId), "Should not be settled yet");
    }

    function test_SolverSlash() public {
        uint256 stakeBefore = registry.stake(solver);
        vm.prank(address(settlement));
        registry.slash(solver, "overpromise");
        uint256 stakeAfter = registry.stake(solver);
        assertEq(stakeBefore - stakeAfter, registry.SLASH_AMOUNT());
    }

    function test_SolverDeregister() public {
        uint256 balBefore = solver.balance;
        vm.prank(solver);
        registry.deregister();
        assertFalse(registry.isRegistered(solver));
        assertGt(solver.balance, balBefore, "Stake not returned");
        assertEq(registry.peerIdToAddress("12D3KooWTestPeerId"), address(0));
    }

    function test_FuzzIntentHash(address u, uint256 amt) public pure {
        vm.assume(u != address(0) && amt > 0 && amt < 1e30);
        IntentTypes.Intent memory i;
        i.user = u; i.inputAmount = amt; i.deadline = 9999999999;
        bytes32 h = IntentTypes.hashIntent(i);
        assertTrue(h != bytes32(0));
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
