// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {SNIP} from "../../src/SNIP.sol";
import {AntiSniperDecayHook} from "../../src/AntiSniperDecayHook.sol";
import {HookFlags} from "../../src/HookFlags.sol";
import {LaunchFixture, LaunchParameters} from "./LaunchFixture.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";

abstract contract HookTestBase is Test {
    PoolManager internal manager;
    AntiSniperDecayHook internal hook;
    LaunchFixture internal factory;
    PoolSwapTest internal router;
    SNIP internal token;
    PoolKey internal key;
    PoolId internal id;
    uint256 internal launchBlock;
    uint128 internal seedLiquidity;

    function setUp() public virtual {
        vm.roll(100);
        vm.deal(address(this), 100_000 ether);
        manager = new PoolManager(address(this));
        factory = new LaunchFixture(manager);
        bytes32 hash = keccak256(abi.encodePacked(type(AntiSniperDecayHook).creationCode, abi.encode(manager)));
        (bytes32 salt,) = mine(address(factory), hash, HookFlags.REQUIRED);
        hook = factory.deployHook(salt);
        BalanceDelta seedDelta;
        (token, key, seedLiquidity, seedDelta) = factory.launch(
            IHooks(address(hook)),
            LaunchParameters.SQRT_PRICE_X96,
            LaunchParameters.TICK_LOWER,
            LaunchParameters.TICK_UPPER,
            LaunchParameters.SEED_SNIP
        );
        assertEq(seedDelta.amount0(), 0);
        assertEq(address(manager).balance, 0);
        assertGt(token.balanceOf(address(manager)), 0);
        assertLe(token.balanceOf(address(manager)), LaunchParameters.SEED_SNIP);
        id = key.toId();
        launchBlock = block.number;
        router = new PoolSwapTest(manager);
        token.approve(address(router), type(uint256).max);
    }

    function mine(address deployer, bytes32 initCodeHash, uint160 flags)
        internal
        pure
        returns (bytes32 salt, address predicted)
    {
        for (uint256 i; i < 200_000; ++i) {
            salt = bytes32(i);
            predicted =
                address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initCodeHash)))));
            if (HookFlags.matches(predicted, flags)) return (salt, predicted);
        }
        revert("salt search exhausted");
    }

    function swap(bool buy, int256 amount) internal returns (BalanceDelta) {
        return router.swap{value: buy ? 100 ether : 0}(
            key,
            SwapParams(buy, amount, buy ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
    }

    function claims(Currency currency) internal view returns (uint256) {
        return manager.balanceOf(address(hook), currency.toId());
    }

    function abs(int128 amount) internal pure returns (uint256) {
        return uint256(-int256(amount));
    }

    receive() external payable {}
}
