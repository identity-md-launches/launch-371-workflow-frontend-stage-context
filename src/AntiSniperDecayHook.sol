// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, toBeforeSwapDelta} from "v4-core/src/types/BeforeSwapDelta.sol";

/// @notice Immutable input-currency tax on native-ETH pools, redeemable only to dEaD.
/// @dev Callbacks mint claims, never withdraw reserves. No identity or hookData is trusted.
contract AntiSniperDecayHook is IHooks, IUnlockCallback {
    IPoolManager public immutable poolManager;
    uint256 public constant START_RATE = 5_000;
    uint256 public constant END_RATE = 30;
    uint256 public constant DECAY_BLOCKS = 1_000;
    uint256 public constant BPS = 10_000;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    mapping(PoolId => uint256) public startBlock;
    mapping(PoolId => bool) public initialized;

    error OnlyPoolManager();
    error CallbackNotEnabled();
    error PartialFill();
    error AmountTooLarge();

    event FeeCharged(PoolId indexed poolId, uint256 blockNumber, uint256 rate, Currency indexed currency, uint256 fee);
    event FeesBurned(Currency indexed currency, uint256 amount);

    constructor(IPoolManager manager) {
        poolManager = manager;
        Hooks.validateHookPermissions(IHooks(address(this)), getHookPermissions());
    }

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        _;
    }

    function getHookPermissions() public pure returns (Hooks.Permissions memory p) {
        p.afterInitialize = true;
        p.beforeSwap = true;
        p.afterSwap = true;
        p.beforeSwapReturnDelta = true;
        p.afterSwapReturnDelta = true;
    }

    /// @dev PoolManager guarantees initialization occurs once. No pool/price/factory gate.
    function afterInitialize(address, PoolKey calldata key, uint160, int24) external onlyPoolManager returns (bytes4) {
        if (key.currency0.isAddressZero()) {
            PoolId id = key.toId();
            startBlock[id] = block.number;
            initialized[id] = true;
        }
        return IHooks.afterInitialize.selector;
    }

    /// @notice Zero for unknown or non-native pools. Initialization at block zero is supported.
    function currentRate(PoolId id) public view returns (uint256) {
        if (!initialized[id]) return 0;
        uint256 elapsed = block.number - startBlock[id];
        if (elapsed >= DECAY_BLOCKS) return END_RATE;
        return START_RATE - ((START_RATE - END_RATE) * elapsed / DECAY_BLOCKS);
    }

    function blocksLeft(PoolId id) external view returns (uint256) {
        if (!initialized[id]) return 0;
        uint256 elapsed = block.number - startBlock[id];
        return elapsed >= DECAY_BLOCKS ? 0 : DECAY_BLOCKS - elapsed;
    }

    function beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (!key.currency0.isAddressZero()) return (IHooks.beforeSwap.selector, BeforeSwapDelta.wrap(0), 0);

        // The final caller delta must fit int128 as well as the fee. Check before negation.
        int256 limit = int256(type(int128).max);
        if (params.amountSpecified < -limit || params.amountSpecified > limit) revert AmountTooLarge();
        uint256 fee = 0;
        if (params.amountSpecified < 0) {
            PoolId id = key.toId();
            uint256 rate = currentRate(id);
            fee = uint256(-params.amountSpecified) * rate / BPS;
            _charge(id, params.zeroForOne ? key.currency0 : key.currency1, rate, fee);
        }
        return (IHooks.beforeSwap.selector, toBeforeSwapDelta(int128(int256(fee)), 0), 0);
    }

    function afterSwap(address, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, int128)
    {
        if (!key.currency0.isAddressZero()) return (IHooks.afterSwap.selector, 0);
        PoolId id = key.toId();
        uint256 rate = currentRate(id);
        int256 input = params.zeroForOne ? int256(delta.amount0()) : int256(delta.amount1());
        int256 output = params.zeroForOne ? int256(delta.amount1()) : int256(delta.amount0());

        if (params.amountSpecified < 0) {
            uint256 prepaidFee = uint256(-params.amountSpecified) * rate / BPS;
            if (input != params.amountSpecified + int256(prepaidFee)) revert PartialFill();
            return (IHooks.afterSwap.selector, 0);
        }

        if (output != params.amountSpecified) revert PartialFill();
        uint256 poolInput = uint256(-input);
        uint256 fee = poolInput * rate / (BPS - rate);
        if (poolInput + fee > uint256(uint128(type(int128).max))) revert AmountTooLarge();
        _charge(id, params.zeroForOne ? key.currency0 : key.currency1, rate, fee);
        return (IHooks.afterSwap.selector, int128(int256(fee)));
    }

    function _charge(PoolId id, Currency currency, uint256 rate, uint256 fee) private {
        if (fee != 0) poolManager.mint(address(this), currency.toId(), fee);
        emit FeeCharged(id, block.number, rate, currency, fee);
    }

    /// @notice Anyone can redeem the hook's entire balance of a currency's claims to dEaD.
    /// @dev Must be called outside an existing PoolManager unlock. Claims are the fee ledger.
    function burnFees(Currency currency) external {
        poolManager.unlock(abi.encode(currency));
    }

    function unlockCallback(bytes calldata data) external onlyPoolManager returns (bytes memory) {
        Currency currency = abi.decode(data, (Currency));
        uint256 amount = poolManager.balanceOf(address(this), currency.toId());
        if (amount != 0) {
            poolManager.burn(address(this), currency.toId(), amount);
            poolManager.take(currency, DEAD, amount);
        }
        emit FeesBurned(currency, amount);
        return bytes("");
    }

    // Disabled callbacks remain manager-gated. No liquidity callback permission is enabled.
    function beforeInitialize(address, PoolKey calldata, uint160) external view onlyPoolManager returns (bytes4) {
        revert CallbackNotEnabled();
    }

    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        view
        onlyPoolManager
        returns (bytes4)
    {
        revert CallbackNotEnabled();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external view onlyPoolManager returns (bytes4, BalanceDelta) {
        revert CallbackNotEnabled();
    }

    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        view
        onlyPoolManager
        returns (bytes4)
    {
        revert CallbackNotEnabled();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external view onlyPoolManager returns (bytes4, BalanceDelta) {
        revert CallbackNotEnabled();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        view
        onlyPoolManager
        returns (bytes4)
    {
        revert CallbackNotEnabled();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        view
        onlyPoolManager
        returns (bytes4)
    {
        revert CallbackNotEnabled();
    }
}
