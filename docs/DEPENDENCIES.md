# Vendored dependencies

These files are ordinary repository files, without submodules or install-time downloads. Source was obtained from the upstream repositories at the exact revisions below. Only reachable Solidity dependencies are retained from v4-core/OpenZeppelin; forge-std's source distribution is retained for tests. Original copyright headers and licenses are preserved.

| Dependency | Pinned revision | Files used / license |
| --- | --- | --- |
| [Uniswap v4-core](https://github.com/Uniswap/v4-core/tree/46c6834698c48bc4a463a86d8420f4eb1d7f3b75) | `46c6834698c48bc4a463a86d8420f4eb1d7f3b75` | Core, types/interfaces/libraries, real PoolManager, test routers and CurrencySettler; per-file MIT or BUSL-1.1, texts in `lib/v4-core/licenses/` |
| [OpenZeppelin Contracts v5.1.0](https://github.com/OpenZeppelin/openzeppelin-contracts/tree/69c8def5f222ff96f2b5beff05dfba996368aa79) | `69c8def5f222ff96f2b5beff05dfba996368aa79` | ERC20 and its interface/context dependencies; MIT |
| [forge-std v1.9.7](https://github.com/foundry-rs/forge-std/tree/77041d2ce690e692d6e03cc812b57d1ddaa4d505) | `77041d2ce690e692d6e03cc812b57d1ddaa4d505` | Test framework; Apache-2.0 or MIT |
| [Solmate](https://github.com/transmissions11/solmate/tree/4b47a19038b798b4a33d9749d25e570443520647) | `4b47a19038b798b4a33d9749d25e570443520647` | `Owned.sol`, the pinned v4-core PoolManager's protocol-fee ownership dependency; AGPL-3.0-only |

The hook and token do not inherit PoolManager's ownership machinery. The real manager deployed in tests needs Solmate because that is how upstream v4-core implements protocol-fee ownership. Runtime production contracts remain ownerless.
