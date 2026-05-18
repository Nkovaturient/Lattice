// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Script, console} from "forge-std/Script.sol";
import {LatticeDeployLib} from "./LatticeDeployLib.sol";
import {MockIntentSettlement} from "../src/MockIntentSettlement.sol";

/// @title DeployAll
/// @notice Production pair deploy for `SolverRegistry` + `IntentSettlement`.
/// @dev See `LatticeDeployLib` — do not deploy either contract in isolation with a
///      placeholder settlement address. Use this script (or the lib in tests) only.
contract DeployAll is Script {
    function deployMock(address registryAddress) external {
        vm.startBroadcast();
        MockIntentSettlement mock = new MockIntentSettlement(registryAddress);
        console.log("MockIntentSettlement deployed at:", address(mock));
        vm.stopBroadcast();
    }

    function run() external {
        vm.startBroadcast();

        LatticeDeployLib.Pair memory pair =
            LatticeDeployLib.deployPair(vm, msg.sender, msg.sender);

        console.log("SolverRegistry deployed at:", address(pair.registry));
        console.log("IntentSettlement deployed at:", address(pair.settlement));
        console.log("Cross-check settlementContract:", pair.registry.settlementContract());
        console.log("Cross-check registry immutables:", address(pair.settlement.registry()));

        vm.stopBroadcast();
    }
}
