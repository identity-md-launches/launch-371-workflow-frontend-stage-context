# Contract interfaces

Machine-readable ABI arrays are in [SNIP.json](abi/SNIP.json) and [AntiSniperDecayHook.json](abi/AntiSniperDecayHook.json). Solidity user-defined `PoolId` and `Currency` types encode as `bytes32` and `address`, respectively. Zero-address currency means native ETH, not WETH.

## SNIP

The zero-argument constructor mints the entire supply to its caller. Standard ERC-20 methods: `name`, `symbol`, `decimals`, `totalSupply`, `balanceOf`, `allowance`, `approve`, `transfer`, and `transferFrom`. Transfers/approvals emit the standard `Transfer`/`Approval` events. There are no mint, burn, owner, or admin methods. Standard OpenZeppelin ERC-6093 custom errors are included in the ABI.

## AntiSniperDecayHook

| Method | Meaning |
| --- | --- |
| `constructor(address manager)` | Sole constructor argument; permission bits are validated at creation |
| `poolManager()` | Immutable manager address |
| `getHookPermissions()` | Struct of all 14 permission booleans; exactly five enabled |
| `startBlock(bytes32 poolId)` | Native pool initialization block |
| `initialized(bytes32 poolId)` | Distinguishes a native pool initialized at block zero from an unknown pool |
| `currentRate(bytes32 poolId)` | Integer basis points (5000 down to 30); zero for unknown/non-native pools |
| `blocksLeft(bytes32 poolId)` | Blocks until the 30-bps floor; zero for unknown/non-native pools or completed decay |
| `burnFees(address currency)` | Permissionless redemption of all that currency's claims to dEaD, outside an existing manager unlock |
| `START_RATE`, `END_RATE`, `DECAY_BLOCKS`, `BPS`, `DEAD` | Source constants exposed as views |

The pool ID is `keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks))`. Include the actual hook address and pool fee/spacing when computing it. The return-delta callbacks use the canonical v4 ABI; only the configured manager may call them. Applications call the manager through an appropriate router, not the hook callbacks directly.

Events:

```solidity
event FeeCharged(
    bytes32 indexed poolId,
    uint256 blockNumber,
    uint256 rate,
    address indexed currency,
    uint256 fee
);
event FeesBurned(address indexed currency, uint256 amount);
```

`FeeCharged` is emitted once for each successful taxed native-pool swap, including zero-unit fees: in `beforeSwap` for exact input and in `afterSwap` for exact output. Amounts are raw base units. All logs roll back on failure. `FeesBurned` records the total currency redemption, possibly zero, across all pools on this hook; claims are denominated by currency, not pool ID. External donated claims are included in redemption.

Errors:

| Error | Trigger |
| --- | --- |
| `OnlyPoolManager()` | A callback caller is not the immutable manager |
| `CallbackNotEnabled()` | Manager directly calls a disabled entry point; ordinary v4 dispatch never calls these |
| `PartialFill()` | Native exact-input remainder was not fully consumed or exact output was not fully delivered |
| `AmountTooLarge()` | A native order or exact-output total exceeds the supported signed delta limit |
| `HookAddressNotValid(address)` | Constructor address bits disagree with declared permissions |

When PoolManager invokes a failing hook, v4 wraps the hook error in `WrappedError(address,bytes4,bytes,bytes)` with `HookCallFailed()` context. Direct hook errors are not wrapped. Manager settlement, locking, token transfer, and ERC-6909 balance errors can also propagate. The test suite checks the exact wrapped `PartialFill()` payload.
