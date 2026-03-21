// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {Script, console} from "forge-std/Script.sol";
import {SolverRegistry} from "../src/SolverRegistry.sol";
import {IntentSettlement} from "../src/IntentSettlement.sol";

contract DeployAll is Script {
    SolverRegistry public registry;
    IntentSettlement public settlement;

    function run() external {
        vm.startBroadcast();
        console.log("Deploying SolverRegistry and IntentSettlement...");
        
        // Deploy SolverRegistry
        registry = new SolverRegistry(address(this));
        console.log("SolverRegistry deployed at:", address(registry));
        console.log("SolverRegistry address:", address(registry));
        
        // Deploy IntentSettlement
        settlement = new IntentSettlement(address(registry));
        console.log("IntentSettlement deployed at:", address(settlement));
        console.log("IntentSettlement address:", address(settlement));
        
        vm.stopBroadcast();
    }
}
