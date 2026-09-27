# Snipeproof (SNIP) and AntiSniperDecayHook

This contribution implements the fixed-supply SNIP token and an immutable Uniswap v4 input-fee hook. It includes a local factory launch rehearsal, success/failure tests, fuzzing, stateful claim-accounting checks, and ABI exports. The target deployment is Sepolia, chain ID **11155111**.

```sh
forge build
forge test
forge fmt --check
python3 scripts/export_abis.py --check
```

Solidity is pinned to **0.8.26**, targeting Cancun with optimization (200 runs) and `bytecode_hash = "none"`. All Solidity dependencies are ordinary vendored files; no network, submodules, FFI, filesystem cheatcode permissions, environment variables, or RPC fork are required by the build/tests. The verification environment must supply Foundry and the pinned compiler. Python 3 is needed only to regenerate/check ABI exports.

## Contracts

`src/SNIP.sol:SNIP` has no constructor arguments. Its constructor mints exactly **1,000,000,000 × 10^18** units to `msg.sender`, so the actual deploying factory receives the supply. Metadata is Snipeproof / SNIP / 18 decimals. It is a standard ERC-20 with allowances and exact transfers, without any further mint path, admin, transfer tax, pause, ownership, or upgrade mechanism. Sending tokens to dEaD leaves `totalSupply()` unchanged.

`src/AntiSniperDecayHook.sol:AntiSniperDecayHook` takes exactly one constructor argument, `IPoolManager`. For Sepolia pass **0xE03A1074c86CFeDd5C142C4F04F1a1536e203543**. There is no token or owner argument. The token currency comes from the pool key. The address must have low 14 bits **0x10CC**; the constructor invokes `Hooks.validateHookPermissions` for precisely `afterInitialize`, `beforeSwap`, `afterSwap`, `beforeSwapReturnDelta`, and `afterSwapReturnDelta`.

All callbacks, including `unlockCallback` and disabled callback entry points, reject callers other than the configured PoolManager. Enabled `afterInitialize` has no price, fee, token, sender, or liquidity gate. On native pools it records the initialization block; on pools whose currency0 is not native ETH it returns its selector without writing state. Liquidity callbacks are disabled. This preserves factory initialization and one-sided SNIP seeding. Callback authentication is the necessary exception to “never reverts”; ordinary manager initialization is never intentionally rejected by hook logic.

The hook contains no administrator, setter, pause, sweep, proxy, or privileged recipient. `hookData` is ignored: there are no user credits or router rewards. It is unauthenticated and must not be interpreted as proof of swapper identity.

## Fee rules and rounding

Each native pool has its own `PoolId` and initialization block `s`. With `e = block.number - s`:

```
rate = 5000 - floor(4970 * e / 1000)   when e < 1000
rate = 30                             thereafter
```

| Elapsed blocks | Rate, bps | Blocks left |
| --- | --- | --- |
| 0 | 5000 | 1000 |
| 1 | 4996 | 999 |
| 500 | 2515 | 500 |
| 999 | 35 | 1 |
| 1000 and later | 30 | 0 |

Both buy and sell fees use the **input currency**. The fee is separate from the pool's 3000-pip (0.3%) LP fee, which is included in the pool's own input accounting.

* Exact input: for total specified input `A`, `F = floor(A × rate / 10000)`. `beforeSwap` returns positive specified delta `F`, zero unspecified delta, and no LP override. The pool receives `A − F`. `afterSwap` requires that the pool consumed exactly that amount.
* Exact output: `beforeSwap` returns zero. `afterSwap` requires that the requested output was filled and reads input `P` from the pool delta. It charges `F = floor(P × rate / (10000 − rate))` as positive unspecified delta. Total payment is `T = P + F`. In integer units, `F = floor(T × rate / 10000)` and `0 ≤ T × rate − F × 10000 < 10000 − rate`.

At 50%, the exact-input hook fee cannot exceed half the specified input. Exact-output fees affect the unspecified input, so they cannot flip the swap's specified-amount sign. The pool still performs the trade. Price-limit or liquidity-exhaustion partial fills revert with `PartialFill()` and roll back fees, claims, price changes, and settlement. Input budgets and exact-output amounts are limited to `type(int128).max`; exact-output total input must also fit this limit. Oversize native orders fail with `AmountTooLarge()` before an unsafe narrowing.

Unknown and non-native pool IDs return zero for `currentRate`, `startBlock`, and `blocksLeft`. `initialized` distinguishes native pools initialized at block zero. Non-native swaps return zero deltas, emit no hook events, and have no hook partial-fill gate.

Rounding is intentionally downward for monetary fees. Splitting trades can save at most the sum of rounding dust: two one-wei exact-input orders pay zero at 50%, whereas one two-wei order pays one wei. At 30 bps an input below 334 base units pays zero. This follows the approved formula. A separate native pool gets a fresh high-rate window; an older native pool on this hook eventually charges 30 bps. The token itself does not tax other venues or non-native pools.

## Claims and permissionless burning

Each charged fee mints exactly `F` ERC-6909 claims to the hook through `poolManager.mint`. No swap callback calls `take` or transfers tokens. The returned positive delta offsets the mint debit; the router settles the user's complete input before the manager closes its unlock. This allows the very first ETH buy when the manager starts with **zero ETH**.

`burnFees(Currency currency)` is permissionless and takes no recipient. It opens a manager unlock; its manager-only `unlockCallback` burns the entire balance of that currency's claims and takes the same amount to **0x000000000000000000000000000000000000dEaD**. Call it outside any existing manager unlock. Zero balances are harmless. A failed transfer reverts the entire redemption and restores claims. The hook never grants ERC-6909 approvals or operator permissions.

Claims are the authoritative unburned-fee ledger. Without external donations, `claims[currency] = sum(FeeCharged.fee) − sum(FeesBurned.amount)`; fuzz and stateful tests check this against independent accounting derived from user payments. ERC-6909 permits unsolicited transfers or third-party mints to any address. Such donated claims are also irreversibly burnable to dEaD; when reconciling against events, include incoming external ERC-6909 transfers. No contract can prohibit these incoming transfers at the recipient. Raw ERC-20 or forced ETH sent directly to the hook is outside the claim ledger and has no recovery path.

## Deployment handoff and rehearsal assumptions

The supplied workflow did not include `launch.json`, a numeric manifest price, a factory implementation, its address, its seed allocation, or its exact tick range. The local rehearsal reproduces the specified sequence using a real unmodified v4-core PoolManager: CREATE2 hook deployment with constructor validation, factory deployment of SNIP, initialization, SNIP-only liquidity, then a first buy with no pre-funded ETH reserves. It does not claim byte-for-byte equivalence to an unavailable factory.

The explicit **proposed rehearsal parameters** are in `docs/deployment-parameters.json` and `test/helpers/LaunchFixture.sol`:

| Parameter | Fixture value |
| --- | --- |
| Initial price | 1,000,000 SNIP per ETH |
| Initial sqrtPriceX96 | 79228162514264337593543950336000 |
| Pool fee / spacing | 3000 / 60 |
| Currency0 / currency1 | native ETH / newly deployed SNIP |
| Seed tick range | −887220 to 138120 |
| SNIP seed budget | 900,000,000 SNIP |

The upper tick lies below the initial price, making the seed entirely currency1. Liquidity is `floor(seed × 2^96 / (sqrtUpper − sqrtLower))`. The fixture transfers the unseeded supply/rounding remainder to its test caller; this is a local balance-ownership convenience, not a specified production allocation. The manifest contributor must align the price, range, and allocation with the actual factory and rerun this rehearsal if they differ.

Deployment services must use the exact reviewed compiler settings, hook creation code plus ABI-encoded manager address, and actual CREATE2 deployer when mining the salt. Compute `address = last20(keccak256(0xff || deployer || salt || keccak256(initCode)))` and require `address & 0x3fff == 0x10cc`. Changing source, compiler settings, constructor arguments, or deployer changes the prediction. The local salt is not a production salt. Deploy SNIP through the factory, validate the minted supply, initialize and seed the native pool, and verify the permission mask, pool ID, price, and recorded start block. On-chain activation is the initialization block, with no delayed/manual start.

This assignment supplies source and ABI exports. The separate manifest assignment owns `launch.json`; an independent contributor owns the adversarial review. Services own publication, source attestation, policy and signed-artifact linkage, admission, and deployment; frontend work follows the live deployment. The Sepolia manager address and actual deployment code, factory behavior, final pool parameters, and deployment salt remain operational checks. No live transaction, funded wallet, fork result, or independent security approval is represented by this local suite.

Keepers or users may periodically call `burnFees` for ETH and SNIP and monitor `FeeCharged`, `FeesBurned`, and the manager's claim balances. Routing integrations must set price/slippage limits for the complete taxed trade and handle partial-fill reverts. Ordinary ERC-20 SNIP and native ETH are the intended assets; successful accounting for adversarial, rebasing, fee-on-transfer, or callback-bearing tokens is not a deployment assumption.

## ABI and verification coverage

ABI arrays are committed as ordinary JSON files at `docs/abi/SNIP.json` and `docs/abi/AntiSniperDecayHook.json`. `python3 scripts/export_abis.py` regenerates them from the pinned compiler. `docs/ABI.md` explains views, events, and errors. Vendored versions and licenses are listed in `docs/DEPENDENCIES.md`.

The suite covers the four taxed swap modes and native first-buy variants, dust, decay boundaries, fuzzed sizes/rates, separate windows, constructor address rejection, manager-only callbacks, non-native no-op behavior, partial-fill atomicity, insufficient settlement, fixed redemption destination, failed/repeated/nested redemptions, unsolicited claim donation, ERC-20 supply/allowances, and runtime escape-hatch opcode scans. The stateful handler interleaves buys, sells, block advances, and both burns, checking claims against unburned fees and manager collateral after every action.

Independent review should reproduce exact call sequences for any findings, especially around boundary rounding, the exact-output denominator, 50% delta limits, dust splitting, parallel native/non-native pools, permission flags, and factory initialization. Local passing tests do not constitute that independent review.
