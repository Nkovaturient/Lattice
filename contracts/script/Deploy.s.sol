// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Script, console} from "forge-std/Script.sol";
import {SolverRegistry} from "../src/SolverRegistry.sol";
import {IntentSettlement} from "../src/IntentSettlement.sol";

contract DeployAll is Script {
    SolverRegistry public registry;
    IntentSettlement public settlement;

    function run() external {
        vm.startBroadcast();

        address deployer = msg.sender;
        uint64 nonce = vm.getNonce(deployer);
        address predictedSettlement = vm.computeCreateAddress(deployer, uint256(nonce) + 1);

        registry = new SolverRegistry(predictedSettlement, deployer);
        console.log("SolverRegistry deployed at:", address(registry));

        settlement = new IntentSettlement(address(registry));
        console.log("IntentSettlement deployed at:", address(settlement));
        require(address(settlement) == predictedSettlement, "settlement address mismatch");

        vm.stopBroadcast();
    }
}
