// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {HookTestBase} from "./helpers/HookTestBase.sol";
import {LaunchParameters} from "./helpers/LaunchFixture.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {AntiSniperDecayHook} from "../src/AntiSniperDecayHook.sol";
import {HookFlags} from "../src/HookFlags.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {CustomRevert} from "v4-core/src/libraries/CustomRevert.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {BalanceDelta, toBalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta} from "v4-core/src/types/BeforeSwapDelta.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TransientStateLibrary} from "v4-core/src/libraries/TransientStateLibrary.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";

contract AntiSniperDecayHookTest is HookTestBase {
    using StateLibrary for IPoolManager;
    using TransientStateLibrary for IPoolManager;

    event FeeCharged(PoolId indexed poolId, uint256 blockNumber, uint256 rate, Currency indexed currency, uint256 fee);
    event FeesBurned(Currency indexed currency, uint256 amount);

    function test_factoryLaunchAndFirstBuyIntoEthlessPool() public {
        assertEq(address(manager).balance, 0);
        (uint160 price,,,) = IPoolManager(address(manager)).getSlot0(id);
        assertEq(price, LaunchParameters.SQRT_PRICE_X96);
        assertEq(token.totalSupply(), 1_000_000_000 ether);
        assertEq(token.balanceOf(address(factory)), 0);
        assertEq(hook.startBlock(id), launchBlock);
        assertEq(hook.currentRate(id), 5000);
        uint256 beforeTokens = token.balanceOf(address(this));
        vm.expectEmit(true, true, false, true, address(hook));
        emit FeeCharged(id, block.number, 5000, key.currency0, 0.5 ether);
        BalanceDelta delta = swap(true, -1 ether);
        assertEq(delta.amount0(), -1 ether);
        assertGt(delta.amount1(), 0);
        assertEq(token.balanceOf(address(this)), beforeTokens + uint128(delta.amount1()));
        assertEq(address(manager).balance, 1 ether);
        assertEq(claims(key.currency0), 0.5 ether);
        assertEq(claims(key.currency1), 0);
        assertEq(address(hook).balance, 0);
        assertEq(token.balanceOf(address(hook)), 0);
        assertEq(IPoolManager(address(manager)).currencyDelta(address(hook), key.currency0), 0);
        assertEq(IPoolManager(address(manager)).currencyDelta(address(hook), key.currency1), 0);
    }

    function test_firstBuyExactOutputAtFiftyPercent() public {
        BalanceDelta delta = swap(true, 1_000 ether);
        uint256 fee = claims(key.currency0);
        assertEq(delta.amount1(), 1_000 ether);
        assertGt(fee, 0);
        assertEq(abs(delta.amount0()), fee * 2);
    }

    function test_exactPermissionMaskAndConstructorValidation() public {
        Hooks.Permissions memory p = hook.getHookPermissions();
        Hooks.validateHookPermissions(IHooks(address(hook)), p);
        assertEq(HookFlags.flagsOf(address(hook)), 0x10CC);
        Hooks.Permissions memory expected;
        expected.afterInitialize = true;
        expected.beforeSwap = true;
        expected.afterSwap = true;
        expected.beforeSwapReturnDelta = true;
        expected.afterSwapReturnDelta = true;
        assertEq(abi.encode(p), abi.encode(expected));
        bytes32 hash = keccak256(abi.encodePacked(type(AntiSniperDecayHook).creationCode, abi.encode(manager)));
        (bytes32 salt, address bad) = mine(address(factory), hash, HookFlags.REQUIRED ^ HookFlags.BEFORE_INITIALIZE);
        vm.expectRevert(abi.encodeWithSelector(Hooks.HookAddressNotValid.selector, bad));
        factory.deployHook(salt);
    }

    function test_rateBoundariesAndViews() public {
        uint256[5] memory blocks_ = [uint256(0), 1, 500, 999, 1000];
        uint256[5] memory rates = [uint256(5000), 4996, 2515, 35, 30];
        for (uint256 i; i < blocks_.length; ++i) {
            vm.roll(launchBlock + blocks_[i]);
            assertEq(hook.currentRate(id), rates[i]);
            assertEq(hook.blocksLeft(id), 1000 - blocks_[i]);
            assertEq(hook.startBlock(id), launchBlock);
        }
        vm.roll(type(uint256).max);
        assertEq(hook.currentRate(id), 30);
        assertEq(hook.blocksLeft(id), 0);
        assertEq(hook.currentRate(PoolId.wrap(bytes32(uint256(99)))), 0);
        assertEq(hook.blocksLeft(PoolId.wrap(bytes32(uint256(99)))), 0);
    }

    function testFuzz_rateMonotoneAndRounding(uint16 offset) public {
        vm.roll(launchBlock + offset);
        uint256 rate = hook.currentRate(id);
        assertGe(rate, 30);
        assertLe(rate, 5000);
        if (offset < 1000) {
            uint256 reduction = 5000 - rate;
            assertLe(reduction * 1000, uint256(offset) * 4970);
            assertGt((reduction + 1) * 1000, uint256(offset) * 4970);
        } else {
            assertEq(rate, 30);
        }
        vm.roll(launchBlock + uint256(offset) + 1);
        assertLe(hook.currentRate(id), rate);
    }

    function test_eachPoolHasItsOwnWindowAndBlockZeroWorks() public {
        vm.roll(launchBlock + 500);
        PoolKey memory other = key;
        other.fee = 500;
        manager.initialize(other, LaunchParameters.SQRT_PRICE_X96);
        assertEq(hook.currentRate(id), 2515);
        assertEq(hook.currentRate(other.toId()), 5000);
        assertEq(hook.startBlock(id), launchBlock);
        assertEq(hook.startBlock(other.toId()), launchBlock + 500);
        other.fee = 100;
        vm.roll(0);
        manager.initialize(other, TickMath.MIN_SQRT_PRICE);
        assertEq(hook.startBlock(other.toId()), 0);
        assertTrue(hook.initialized(other.toId()));
        assertEq(hook.currentRate(other.toId()), 5000);
    }

    function test_duplicateInitializationCannotResetWindow() public {
        vm.roll(launchBlock + 400);
        vm.expectRevert();
        manager.initialize(key, LaunchParameters.SQRT_PRICE_X96);
        assertEq(hook.startBlock(id), launchBlock);
    }

    function testFuzz_exactInBothDirections(uint128 raw, uint16 age, bool buy) public {
        swap(true, -20 ether); // make ETH available for sells
        vm.roll(launchBlock + uint256(age));
        uint256 amount = bound(uint256(raw), buy ? 1e8 : 1e14, buy ? 2 ether : 1_000_000 ether);
        Currency input = buy ? key.currency0 : key.currency1;
        uint256 beforeClaims = claims(input);
        uint256 rate = hook.currentRate(id);
        uint256 expectedFee = amount * rate / 10_000;
        vm.expectEmit(true, true, false, true, address(hook));
        emit FeeCharged(id, block.number, rate, input, expectedFee);
        BalanceDelta delta = swap(buy, -int256(amount));
        assertEq(abs(buy ? delta.amount0() : delta.amount1()), amount);
        assertEq(claims(input) - beforeClaims, expectedFee);
        assertGt(buy ? delta.amount1() : delta.amount0(), 0);
        assertEq(IPoolManager(address(manager)).currencyDelta(address(hook), input), 0);
    }

    function testFuzz_exactOutBothDirectionsAndFractionOfTotal(uint128 raw, uint16 age, bool buy) public {
        swap(true, -20 ether);
        vm.roll(launchBlock + uint256(age));
        uint256 wanted = bound(uint256(raw), buy ? 1e12 : 1, buy ? 1_000_000 ether : 1 ether);
        Currency input = buy ? key.currency0 : key.currency1;
        uint256 beforeClaims = claims(input);
        uint256 rate = hook.currentRate(id);
        BalanceDelta delta = swap(buy, int256(wanted));
        uint256 total = abs(buy ? delta.amount0() : delta.amount1());
        uint256 fee = claims(input) - beforeClaims;
        uint256 poolInput = total - fee;
        assertEq(uint128(buy ? delta.amount1() : delta.amount0()), wanted);
        assertEq(fee, poolInput * rate / (10_000 - rate));
        // Exact rational equality is rounded down: the shortfall is strictly < 1 currency unit.
        assertLe(fee * 10_000, total * rate);
        assertLt(total * rate - fee * 10_000, 10_000 - rate);
        assertEq(fee, total * rate / 10_000);
    }

    function test_fiftyPercentInAllFourModesAndDust() public {
        BalanceDelta buy = swap(true, -20 ether);
        assertEq(claims(key.currency0), 10 ether);
        assertGt(buy.amount1(), 0);
        BalanceDelta sell = swap(false, -1_000 ether);
        assertEq(sell.amount1(), -1_000 ether);
        assertEq(claims(key.currency1), 500 ether);
        uint256 c0 = claims(key.currency0);
        BalanceDelta buyOut = swap(true, 1_000 ether);
        assertEq(abs(buyOut.amount0()), 2 * (claims(key.currency0) - c0));
        uint256 c1 = claims(key.currency1);
        BalanceDelta sellOut = swap(false, 1e12);
        assertEq(abs(sellOut.amount1()), 2 * (claims(key.currency1) - c1));
        c0 = claims(key.currency0);
        c1 = claims(key.currency1);
        assertEq(swap(true, -1).amount0(), -1);
        assertEq(swap(false, -1).amount1(), -1);
        assertEq(claims(key.currency0), c0);
        assertEq(claims(key.currency1), c1);
        assertEq(swap(true, 1).amount1(), 1);
        assertEq(swap(false, 1).amount0(), 1);
    }

    function test_partialFillsRevertAtomicallyInAllFourModes() public {
        swap(true, -20 ether);
        for (uint256 i; i < 4; ++i) {
            bool buy = i < 2;
            bool exactIn = i % 2 == 0;
            uint256 amount = buy ? (exactIn ? 1 ether : 1_000_000 ether) : (exactIn ? 1_000_000 ether : 1 ether);
            (uint160 price,,,) = IPoolManager(address(manager)).getSlot0(id);
            uint256 c0 = claims(key.currency0);
            uint256 c1 = claims(key.currency1);
            uint256 eth = address(manager).balance;
            uint256 snip = token.balanceOf(address(manager));
            vm.expectRevert(
                abi.encodeWithSelector(
                    CustomRevert.WrappedError.selector,
                    address(hook),
                    IHooks.afterSwap.selector,
                    abi.encodeWithSelector(AntiSniperDecayHook.PartialFill.selector),
                    abi.encodeWithSelector(Hooks.HookCallFailed.selector)
                )
            );
            router.swap{value: buy ? 2 ether : 0}(
                key,
                SwapParams(buy, exactIn ? -int256(amount) : int256(amount), buy ? price - 1 : price + 1),
                PoolSwapTest.TestSettings(false, false),
                ""
            );
            assertEq(claims(key.currency0), c0);
            assertEq(claims(key.currency1), c1);
            assertEq(address(manager).balance, eth);
            assertEq(token.balanceOf(address(manager)), snip);
            (uint160 afterPrice,,,) = IPoolManager(address(manager)).getSlot0(id);
            assertEq(afterPrice, price);
        }
    }

    function test_unfundedSettlementRollsBackClaimsAndPrice() public {
        (uint160 price,,,) = IPoolManager(address(manager)).getSlot0(id);
        vm.expectRevert();
        router.swap(
            key, SwapParams(true, -1 ether, TickMath.MIN_SQRT_PRICE + 1), PoolSwapTest.TestSettings(false, false), ""
        );
        assertEq(claims(key.currency0), 0);
        assertEq(address(manager).balance, 0);
        (uint160 afterPrice,,,) = IPoolManager(address(manager)).getSlot0(id);
        assertEq(afterPrice, price);
    }

    function test_burnBothCurrenciesOnlyToDeadAndRepeatIsNoop() public {
        swap(true, -20 ether);
        swap(false, -1_000 ether);
        for (uint256 i; i < 2; ++i) {
            Currency currency = i == 0 ? key.currency0 : key.currency1;
            uint256 fee = claims(currency);
            uint256 beforeDead = currency.balanceOf(hook.DEAD());
            uint256 beforeManager = currency.balanceOf(address(manager));
            vm.expectEmit(true, false, false, true, address(hook));
            emit FeesBurned(currency, fee);
            vm.prank(address(0xB0B));
            hook.burnFees(currency);
            assertEq(currency.balanceOf(hook.DEAD()), beforeDead + fee);
            assertEq(currency.balanceOf(address(manager)), beforeManager - fee);
            assertEq(claims(currency), 0);
            hook.burnFees(currency);
            assertEq(currency.balanceOf(hook.DEAD()), beforeDead + fee);
        }
        assertEq(token.totalSupply(), 1_000_000_000 ether);
    }

    function test_claimsCannotBeTakenOrApprovedByAnyoneElse() public {
        swap(true, -1 ether);
        vm.prank(address(0xB0B));
        vm.expectRevert();
        manager.transferFrom(address(hook), address(0xB0B), 0, 1);
        (bool ok,) = address(hook).call(abi.encodeWithSignature("sweep(address,address)", address(0), address(this)));
        assertFalse(ok);
        assertEq(manager.allowance(address(hook), address(this), 0), 0);
        assertFalse(manager.isOperator(address(hook), address(this)));
        assertEq(claims(key.currency0), 0.5 ether);
    }

    function test_allCallbacksRejectNonManager() public {
        SwapParams memory s = SwapParams(true, -1 ether, TickMath.MIN_SQRT_PRICE + 1);
        ModifyLiquidityParams memory l = ModifyLiquidityParams(-60, 60, 1 ether, 0);
        bytes[11] memory calls = [
            abi.encodeCall(hook.beforeInitialize, (address(this), key, uint160(1 << 96))),
            abi.encodeCall(hook.afterInitialize, (address(this), key, uint160(1 << 96), int24(0))),
            abi.encodeCall(hook.beforeAddLiquidity, (address(this), key, l, bytes(""))),
            abi.encodeCall(
                hook.afterAddLiquidity, (address(this), key, l, BalanceDelta.wrap(0), BalanceDelta.wrap(0), bytes(""))
            ),
            abi.encodeCall(hook.beforeRemoveLiquidity, (address(this), key, l, bytes(""))),
            abi.encodeCall(
                hook.afterRemoveLiquidity,
                (address(this), key, l, BalanceDelta.wrap(0), BalanceDelta.wrap(0), bytes(""))
            ),
            abi.encodeCall(hook.beforeSwap, (address(this), key, s, bytes(""))),
            abi.encodeCall(hook.afterSwap, (address(this), key, s, BalanceDelta.wrap(0), bytes(""))),
            abi.encodeCall(hook.beforeDonate, (address(this), key, uint256(1), uint256(1), bytes(""))),
            abi.encodeCall(hook.afterDonate, (address(this), key, uint256(1), uint256(1), bytes(""))),
            abi.encodeCall(hook.unlockCallback, (abi.encode(key.currency0)))
        ];
        for (uint256 i; i < calls.length; ++i) {
            (bool ok, bytes memory reason) = address(hook).call(calls[i]);
            assertFalse(ok);
            assertEq(reason, abi.encodeWithSelector(AntiSniperDecayHook.OnlyPoolManager.selector));
        }
    }

    function test_nonNativePoolNoStateNoFeesAndNoPartialFillGate() public {
        MockERC20 a = new MockERC20("A", "A", 1_000_000 ether);
        MockERC20 b = new MockERC20("B", "B", 1_000_000 ether);
        (a, b) = address(a) < address(b) ? (a, b) : (b, a);
        PoolKey memory other =
            PoolKey(Currency.wrap(address(a)), Currency.wrap(address(b)), 3000, 60, IHooks(address(hook)));
        manager.initialize(other, uint160(1 << 96));
        assertEq(hook.startBlock(other.toId()), 0);
        assertFalse(hook.initialized(other.toId()));
        assertEq(hook.currentRate(other.toId()), 0);
        assertEq(hook.blocksLeft(other.toId()), 0);
        PoolModifyLiquidityTest lp = new PoolModifyLiquidityTest(manager);
        a.approve(address(lp), type(uint256).max);
        b.approve(address(lp), type(uint256).max);
        a.approve(address(router), type(uint256).max);
        b.approve(address(router), type(uint256).max);
        lp.modifyLiquidity(other, ModifyLiquidityParams(-600, 600, 10_000 ether, 0), "");
        vm.recordLogs();
        for (uint256 i; i < 4; ++i) {
            bool direction = i < 2;
            router.swap(
                other,
                SwapParams(
                    direction,
                    i % 2 == 0 ? -int256(1 ether) : int256(1 ether),
                    direction ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
                ),
                PoolSwapTest.TestSettings(false, false),
                "garbage"
            );
        }
        // A limit one price unit away deliberately permits a partial fill for this unsupported pool.
        (uint160 price,,,) = IPoolManager(address(manager)).getSlot0(other.toId());
        router.swap(other, SwapParams(true, -1 ether, price - 1), PoolSwapTest.TestSettings(false, false), "");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].emitter != address(hook));
        }
        assertEq(claims(other.currency0), 0);
        assertEq(claims(other.currency1), 0);
    }

    function test_sizeLimitsRejectRatherThanNarrow() public {
        vm.prank(address(manager));
        vm.expectRevert(AntiSniperDecayHook.AmountTooLarge.selector);
        hook.beforeSwap(address(this), key, SwapParams(true, type(int256).min, TickMath.MIN_SQRT_PRICE + 1), "");
        vm.prank(address(manager));
        vm.expectRevert(AntiSniperDecayHook.AmountTooLarge.selector);
        hook.beforeSwap(
            address(this), key, SwapParams(true, int256(type(int128).max) + 1, TickMath.MIN_SQRT_PRICE + 1), ""
        );
        vm.prank(address(manager));
        vm.expectRevert(AntiSniperDecayHook.AmountTooLarge.selector);
        hook.afterSwap(
            address(this),
            key,
            SwapParams(true, 1, TickMath.MIN_SQRT_PRICE + 1),
            toBalanceDelta(-type(int128).max, 1),
            ""
        );
    }

    function test_runtimeContainsNoEscapeHatches() public view {
        _checkRuntime(address(hook).code);
        _checkRuntime(address(token).code);
    }

    function _checkRuntime(bytes memory code) internal pure {
        assertGt(code.length, 0);
        assertLe(code.length, 24_576);
        for (uint256 i; i < code.length; ++i) {
            uint8 op = uint8(code[i]);
            if (op >= 0x60 && op <= 0x7f) {
                i += op - 0x5f;
                continue;
            }
            assertTrue(op != 0xff && op != 0xf4 && op != 0xf2, "forbidden opcode");
        }
    }

    function test_burnFailureRollsBackClaims() public {
        swap(true, -20 ether);
        swap(false, -1_000 ether);
        uint256 owed = claims(key.currency1);
        uint256 beforeDead = token.balanceOf(hook.DEAD());
        vm.mockCallRevert(
            address(token), abi.encodeWithSelector(token.transfer.selector, hook.DEAD(), owed), "transfer fails"
        );
        vm.expectRevert();
        hook.burnFees(key.currency1);
        assertEq(claims(key.currency1), owed);
        assertEq(token.balanceOf(hook.DEAD()), beforeDead);
        vm.clearMockedCalls();
        hook.burnFees(key.currency1);
        assertEq(claims(key.currency1), 0);
        assertEq(token.balanceOf(hook.DEAD()), beforeDead + owed);
    }

    function test_burnInsideExistingUnlockRefusesAndPreservesClaims() public {
        swap(true, -1 ether);
        vm.expectRevert(IPoolManager.AlreadyUnlocked.selector);
        manager.unlock(abi.encode(false));
        assertEq(claims(key.currency0), 0.5 ether);
    }

    function test_unsolicitedClaimsAreAlsoIrrevocablyBurnable() public {
        swap(true, -1 ether);
        manager.unlock(abi.encode(true));
        assertTrue(manager.transfer(address(hook), 0, 1 ether));
        assertEq(claims(key.currency0), 1.5 ether);
        uint256 beforeDead = hook.DEAD().balance;
        hook.burnFees(key.currency0);
        assertEq(hook.DEAD().balance - beforeDead, 1.5 ether);
        assertEq(claims(key.currency0), 0);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(manager));
        if (abi.decode(data, (bool))) {
            manager.mint(address(this), 0, 1 ether);
            manager.settle{value: 1 ether}();
        } else {
            hook.burnFees(key.currency0);
        }
        return "";
    }

    function test_splittingOnlySavesSpecifiedRoundingDust() public {
        // At 50%, a two-wei order pays one wei; two one-wei orders round to zero.
        swap(true, -2);
        assertEq(claims(key.currency0), 1);
        swap(true, -1);
        swap(true, -1);
        assertEq(claims(key.currency0), 1);
        vm.roll(launchBlock + 1000);
        uint256 beforeClaims = claims(key.currency0);
        swap(true, -333);
        assertEq(claims(key.currency0), beforeClaims);
        swap(true, -334);
        assertEq(claims(key.currency0), beforeClaims + 1);
    }
}
