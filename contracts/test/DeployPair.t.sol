// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {LatticeDeployLib} from "../script/LatticeDeployLib.sol";

/// @dev Guards the mutual-immutable deployment path used by `Deploy.s.sol`.
contract DeployPairTest is Test {
    function test_DeployPair_WiresImmutables() public {
        address treasury = makeAddr("treasury");
        LatticeDeployLib.Pair memory pair = LatticeDeployLib.deployPair(vm, address(this), treasury);

        assertTrue(pair.registry.isRegistered(address(0)) == false); // smoke: registry live
        assertEq(pair.registry.treasury(), treasury);
        assertEq(pair.registry.settlementContract(), address(pair.settlement));
        assertEq(address(pair.settlement.registry()), address(pair.registry));
    }
}
