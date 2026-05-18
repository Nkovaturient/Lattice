// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import "forge-std/Test.sol";
import "../src/IntentTypes.sol";
import "../src/MockIntentSettlement.sol";
import "../src/SolverRegistry.sol";

/// @dev Golden vectors from `node test/unit/eip712-parity.test.mjs` (fixed intent fields + deadline).
contract Eip712GoldenTest is Test {
    bytes32 internal constant GOLDEN_STRUCT_HASH =
        0xe4dd258865d80d5b9e88f20fae1cd70d464c7d8d606ef0dedbb6babb7282be9a;

    SolverRegistry internal registry;
    MockIntentSettlement internal mock;

    function setUp() public {
        vm.chainId(42161);
        registry = new SolverRegistry(address(0xBEEF), address(this));
        mock = new MockIntentSettlement(address(registry));
    }

    function _goldenIntent() internal pure returns (MockIntentSettlement.Intent memory i) {
        i.user = address(0x0000000000000000000000000000000000000001);
        i.nonce = 0;
        i.inputToken = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
        i.outputToken = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
        i.inputAmount = 1_000_000_000;
        i.minOutputAmount = 400_000_000_000_000_000;
        i.recipient = address(0x0000000000000000000000000000000000000001);
        i.deadline = 1_735_689_600;
        i.topicTier = 0;
        i.preferredSolver = address(0);
    }

    function _goldenIntentTypes() internal pure returns (IntentTypes.Intent memory i) {
        i.user = address(0x0000000000000000000000000000000000000001);
        i.nonce = 0;
        i.inputToken = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
        i.outputToken = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
        i.inputAmount = 1_000_000_000;
        i.minOutputAmount = 400_000_000_000_000_000;
        i.recipient = address(0x0000000000000000000000000000000000000001);
        i.deadline = 1_735_689_600;
        i.topicTier = 0;
        i.preferredSolver = address(0);
    }

    function test_IntentStructHash_MatchesJsGoldenVector() public pure {
        assertEq(IntentTypes.hashIntent(_goldenIntentTypes()), GOLDEN_STRUCT_HASH);
    }

    function test_MockHashIntent_MatchesStructHashPlusDomain() public view {
        MockIntentSettlement.Intent memory i = _goldenIntent();
        bytes32 structHash = IntentTypes.hashIntent(_goldenIntentTypes());
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", mock.domainSeparator(), structHash));
        assertEq(mock.hashIntent(i), digest, "Mock EIP-712 digest must match IntentTypes struct hash + domain");
    }
}
