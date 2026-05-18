// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @dev Shared custom errors for `IntentSettlement` and `MockIntentSettlement` (ethers `parseError`-friendly).
library IntentSettlementErrors {
    error IntentAlreadySettled(bytes32 intentId);
    error IntentDeadlineNotPassed(uint64 deadline, uint256 blockTimestamp);
    error IntentPastDeadline(uint64 deadline, uint256 blockTimestamp);
    error BidExpired(uint64 bidDeadline, uint256 blockTimestamp);
    error BidExceedsIntentDeadline(uint64 bidDeadline, uint64 intentDeadline);
    error ERC20TokensOnly();
    error ZeroUser(); // blocks signature bypass: ecrecover failure maps to address(0)
    error ZeroRecipient();
    error ZeroInputAmount();
    error ZeroMinOutput();
    error SolverNotRegistered(address solver);
    error InvalidIntentSignature(address recovered, address expected);
    error NonceMismatch(uint256 onChain, uint256 inIntent);
    error InvalidBidSignature(address recovered, address expected);
    error BidIntentIdMismatch(bytes32 bidIntentId, bytes32 computedIntentId);
    error BidSolverMismatch(address bidSolver, address msgSender);
    error BidBelowFloor(uint256 bidOutput, uint256 minOutput);
    error NotPreferredSolver(address preferredSolver, address actualSolver);
    error SolverTierInsufficient(uint8 solverTier, uint8 requiredTier);
    error OutputBelowMinimum(uint256 actualOutput, uint256 minOutput);
    error IntentNotSettled(bytes32 intentId);
    error AlreadySlashedForOverpromise(bytes32 intentId);
    error NoOverpromiseToSlash(uint256 recorded, uint256 bidOutput);
    error OverpromiseTooSmall(uint256 shortfall, uint256 minShortfall);
    error NoSettlementRecord(bytes32 intentId);
    error SlashWindowOpen(uint64 pruneAfter, uint256 blockTimestamp);
    error AlreadySlashed(bytes32 intentId);
}
