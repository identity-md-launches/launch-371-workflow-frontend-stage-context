// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SNIP} from "../../src/SNIP.sol";
import {AntiSniperDecayHook} from "../../src/AntiSniperDecayHook.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {CurrencySettler} from "v4-core/test/utils/CurrencySettler.sol";

/// @dev Explicit rehearsal assumptions; align the separately authored manifest with these values.
library LaunchParameters {
    uint160 internal constant SQRT_PRICE_X96 = 79228162514264337593543950336000; // 1,000,000 SNIP / ETH
    int24 internal constant TICK_LOWER = -887220;
    int24 internal constant TICK_UPPER = 138120;
    uint256 internal constant SEED_SNIP = 900_000_000 ether;
}

/// @notice Local factory stand-in: deploy, initialize, then seed with SNIP only in one call.
/// @dev Not a production factory or a claim about unpublished factory bytecode.
contract LaunchFixture is IUnlockCallback {
    using CurrencySettler for Currency;
    IPoolManager public immutable manager;

    constructor(IPoolManager manager_) {
        manager = manager_;
    }

    function deployHook(bytes32 salt) external returns (AntiSniperDecayHook) {
        return new AntiSniperDecayHook{salt: salt}(manager);
    }

    function launch(IHooks hook, uint160 price, int24 lower, int24 upper, uint256 seed)
        external
        returns (SNIP token, PoolKey memory key, uint128 liquidity, BalanceDelta delta)
    {
        token = new SNIP();
        key = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(token)), 3000, 60, hook);
        manager.initialize(key, price);
        liquidity = uint128(
            FullMath.mulDiv(seed, 1 << 96, TickMath.getSqrtPriceAtTick(upper) - TickMath.getSqrtPriceAtTick(lower))
        );
        delta = abi.decode(
            manager.unlock(abi.encode(key, ModifyLiquidityParams(lower, upper, int256(uint256(liquidity)), 0))),
            (BalanceDelta)
        );
        require(delta.amount0() == 0 && delta.amount1() < 0, "seed must be SNIP only");
        token.transfer(msg.sender, token.balanceOf(address(this)));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(manager), "manager only");
        (PoolKey memory key, ModifyLiquidityParams memory params) = abi.decode(data, (PoolKey, ModifyLiquidityParams));
        (BalanceDelta delta,) = manager.modifyLiquidity(key, params, "");
        require(delta.amount0() == 0, "unexpected ETH seed");
        key.currency1.settle(manager, address(this), uint256(-int256(delta.amount1())), false);
        return abi.encode(delta);
    }
}
