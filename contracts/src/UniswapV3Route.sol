// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @dev Packed Uniswap v3 path validation (token20 + fee3 per hop segment).
library UniswapV3Route {
    uint24 internal constant FEE_LOW = 500;
    uint24 internal constant FEE_MED = 3000;
    uint24 internal constant FEE_HIGH = 10_000;

    error InvalidRouteLength(uint256 length);
    error RouteInputTokenMismatch(address routeStart, address expected);
    error RouteOutputTokenMismatch(address routeEnd, address expected);
    error RouteZeroHopToken(uint256 offset);
    error InvalidRouteFee(uint24 fee);

    /// @notice Length, endpoint alignment, non-zero bridge tokens, and allowed V3 fee tiers.
    function validate(bytes calldata route, address inputToken, address outputToken) internal pure {
        uint256 len = route.length;
        if (len < 43 || (len - 43) % 23 != 0) revert InvalidRouteLength(len);

        address routeStart;
        address routeEnd;
        assembly {
            routeStart := shr(96, calldataload(route.offset))
            routeEnd := shr(96, calldataload(add(route.offset, sub(len, 20))))
        }

        if (routeStart != inputToken) revert RouteInputTokenMismatch(routeStart, inputToken);
        if (routeEnd != outputToken) revert RouteOutputTokenMismatch(routeEnd, outputToken);

        for (uint256 i = 23; i + 43 <= len; i += 23) {
            address hop;
            assembly {
                hop := shr(96, calldataload(add(route.offset, i)))
            }
            if (hop == address(0)) revert RouteZeroHopToken(i);
        }

        for (uint256 off = 20; off + 23 <= len; off += 23) {
            uint24 fee;
            assembly {
                fee := shr(232, calldataload(add(route.offset, off)))
            }
            if (fee != FEE_LOW && fee != FEE_MED && fee != FEE_HIGH) revert InvalidRouteFee(fee);
        }
    }
}
