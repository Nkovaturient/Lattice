// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Script, console} from "forge-std/Script.sol";
import {SolverRegistry} from "../src/SolverRegistry.sol";
import {IntentSettlement} from "../src/IntentSettlement.sol";
import {MockIntentSettlement} from "../src/MockIntentSettlement.sol";

contract DeployAll is Script {
    SolverRegistry public registry;
    IntentSettlement public settlement;

    /**
     * @notice Deploy `MockIntentSettlement` bound to an existing `SolverRegistry`.
     * @dev The registry is only used for `isActiveAndStaked` / `solverTier`. User intent
     *      nonces live on the mock contract (see `MockIntentSettlement.sol`).
     *      Update app `.env` `SETTLEMENT_CONTRACT_ADDRESS` to the printed mock address and
     *      align EIP-712 `verifyingContract` / `INTENT_SETTLEMENT_ADDRESS` with that address.
     */
    function deployMock(address registryAddress) external {
        vm.startBroadcast();
        MockIntentSettlement mock = new MockIntentSettlement(registryAddress);
        console.log("MockIntentSettlement deployed at:", address(mock));
        vm.stopBroadcast();
    }

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
