// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {HookTestBase} from "./helpers/HookTestBase.sol";
import {AntiSniperDecayHook} from "../src/AntiSniperDecayHook.sol";
import {SNIP} from "../src/SNIP.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {TransientStateLibrary} from "v4-core/src/libraries/TransientStateLibrary.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";

contract ClaimsHandler is Test {
    AntiSniperDecayHook public immutable hook;
    PoolSwapTest public immutable router;
    PoolKey internal key;
    uint256 public charged0;
    uint256 public charged1;
    uint256 public burned0;
    uint256 public burned1;

    constructor(AntiSniperDecayHook hook_, PoolSwapTest router_, PoolKey memory key_) {
        hook = hook_;
        router = router_;
        key = key_;
        charged0 = hook.poolManager().balanceOf(address(hook), 0);
        SNIP(Currency.unwrap(key.currency1)).approve(address(router), type(uint256).max);
    }

    function buy(uint128 raw, bool exactIn) external {
        uint256 amount = bound(raw, exactIn ? 1e12 : 1 ether, exactIn ? 0.01 ether : 1_000 ether);
        _swap(true, exactIn ? -int256(amount) : int256(amount));
    }

    function sell(uint128 raw, bool exactIn) external {
        uint256 amount = bound(raw, exactIn ? 1 ether : 1e10, exactIn ? 1_000 ether : 1e14);
        _swap(false, exactIn ? -int256(amount) : int256(amount));
    }

    function _swap(bool buy_, int256 amount) internal {
        uint256 rate = hook.currentRate(key.toId());
        BalanceDelta delta = router.swap{value: buy_ ? 1 ether : 0}(
            key,
            SwapParams(buy_, amount, buy_ ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1),
            PoolSwapTest.TestSettings(false, false),
            "unauthenticated identity is ignored"
        );
        uint256 paid = uint256(-int256(buy_ ? delta.amount0() : delta.amount1()));
        // Ghost accounting derives charges from the actual user payment, not the claim balance.
        uint256 expectedFee = paid * rate / 10_000;
        if (buy_) charged0 += expectedFee;
        else charged1 += expectedFee;
    }

    function advance(uint16 blocks_) external {
        vm.roll(block.number + bound(blocks_, 0, 200));
    }

    function burnEth() external {
        uint256 beforeDead = hook.DEAD().balance;
        hook.burnFees(key.currency0);
        assertEq(hook.DEAD().balance - beforeDead, charged0 - burned0);
        burned0 = charged0;
    }

    function burnSnip() external {
        uint256 beforeDead = key.currency1.balanceOf(hook.DEAD());
        hook.burnFees(key.currency1);
        assertEq(key.currency1.balanceOf(hook.DEAD()) - beforeDead, charged1 - burned1);
        burned1 = charged1;
    }

    receive() external payable {}
}

contract ClaimsInvariantTest is HookTestBase {
    using TransientStateLibrary for IPoolManager;
    ClaimsHandler internal handler;

    function setUp() public override {
        super.setUp();
        swap(true, -20 ether);
        handler = new ClaimsHandler(hook, router, key);
        token.transfer(address(handler), 50_000_000 ether);
        vm.deal(address(handler), 1000 ether);
        bytes4[] memory selectors = new bytes4[](5);
        selectors[0] = handler.buy.selector;
        selectors[1] = handler.sell.selector;
        selectors[2] = handler.advance.selector;
        selectors[3] = handler.burnEth.selector;
        selectors[4] = handler.burnSnip.selector;
        targetSelector(FuzzSelector(address(handler), selectors));
        targetContract(address(handler));
    }

    function invariant_claimsEqualUnburnedFeesAndAreBacked() public view {
        assertEq(claims(key.currency0), handler.charged0() - handler.burned0());
        assertEq(claims(key.currency1), handler.charged1() - handler.burned1());
        assertLe(claims(key.currency0), address(manager).balance);
        assertLe(claims(key.currency1), token.balanceOf(address(manager)));
        assertEq(IPoolManager(address(manager)).currencyDelta(address(hook), key.currency0), 0);
        assertEq(IPoolManager(address(manager)).currencyDelta(address(hook), key.currency1), 0);
        assertEq(address(hook).balance, 0);
        assertEq(token.balanceOf(address(hook)), 0);
        assertEq(token.totalSupply(), 1_000_000_000 ether);
    }
}
