// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Vm} from "forge-std/Vm.sol";
import {SolverRegistry} from "../src/SolverRegistry.sol";
import {IntentSettlement} from "../src/IntentSettlement.sol";

/// @title LatticeDeployLib
/// @notice Deploy `SolverRegistry` + `IntentSettlement` with matching immutable cross-references.
/// @dev Both contracts require the other's address at construction. Deploy order:
///      1. Predict `IntentSettlement` as `computeCreateAddress(deployer, nonce + 1)`.
///      2. Deploy `SolverRegistry(predictedSettlement, treasury)`.
///      3. Deploy `IntentSettlement(registry)` — must equal the predicted address.
///      The deployer must not broadcast any other contract-creation between steps 2 and 3
///      (same `forge script` run is fine; a stray tx on the deployer wallet breaks the nonce).
library LatticeDeployLib {
    error SettlementAddressMismatch(address expected, address actual);
    error RegistrySettlementMismatch(address expected, address actual);
    error SettlementRegistryMismatch(address expected, address actual);

    struct Pair {
        SolverRegistry registry;
        IntentSettlement settlement;
    }

    /// @param vm Foundry cheatcode handle (`vm` in scripts/tests).
    /// @param deployer Account that will send both `new` transactions (nonce source).
    /// @param treasury Receives swept slash proceeds (`SolverRegistry.treasury`).
    function deployPair(Vm vm, address deployer, address treasury)
        internal
        returns (Pair memory pair)
    {
        uint256 settlementNonce = uint256(vm.getNonce(deployer)) + 1;
        address predictedSettlement = vm.computeCreateAddress(deployer, settlementNonce);

        pair.registry = new SolverRegistry(predictedSettlement, treasury);
        pair.settlement = new IntentSettlement(address(pair.registry));

        validatePair(pair.registry, pair.settlement, predictedSettlement);
    }

    function validatePair(
        SolverRegistry registry,
        IntentSettlement settlement,
        address predictedSettlement
    ) internal view {
        address settlementAddr = address(settlement);
        address registryAddr = address(registry);

        if (settlementAddr != predictedSettlement) {
            revert SettlementAddressMismatch(predictedSettlement, settlementAddr);
        }
        if (registry.settlementContract() != settlementAddr) {
            revert RegistrySettlementMismatch(settlementAddr, registry.settlementContract());
        }
        if (address(settlement.registry()) != registryAddr) {
            revert SettlementRegistryMismatch(registryAddr, address(settlement.registry()));
        }
    }
}
