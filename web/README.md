# Snipeproof frontend

A single React + TypeScript + Vite page for the deployed native ETH/SNIP pool on Sepolia. Wagmi manages injected/EIP-6963 browser wallets; viem performs reads, quotes, simulations and transactions. No server, private credentials, WalletConnect project ID, custom font service or wallet key is required.

## Build and preview

Run from the repository root with Node 22.18+ and npm 10:

```sh
npm ci --prefix web
npm run build --prefix web
npm run preview --prefix web
```

`build` typechecks, produces `dist/` with relative asset paths, checks implementation-derived ABIs against the pinned Git revision, and writes `dist/imd-deployment.json` **last**. Publish the whole `dist/` directory. The page works below a gateway subpath; it has no server routes. Never edit the export by hand: rebuild the manifest whenever exported bytes change.

Dependencies are fixed by `web/package-lock.json`. Dependency installation may use the network. With a populated npm cache, `npm ci --offline --prefix web --cache <cache-path>` and the production build work offline; the build itself performs no network requests. A fresh air-gapped machine needs an existing dependency cache/install. Dependencies, browser binaries, npm caches and registry archives are not submitted.

## Deployment configuration

The only deployment configuration consumed by the application is `dist/imd-deployment.json`, fetched at startup. Its `contracts[].abiPath` files are fetched and checked using Keccak-256 over recursively key-sorted, compact JSON, preserving array order. They are raw ABI arrays copied byte-for-byte from `docs/abi/<Contract>.json` at source commit `199da407620fb5cd1ca0a33e17dd68c51775c11f`.

Reproducible build inputs are retained in `web/config/deployment-handoff.json` and `web/config/network-handoff.json`, because assignment inputs are removed before submission. `web/scripts/export.mjs` verifies the local ABI bytes against `git show <pinned-commit>:docs/abi/<Contract>.json` and verifies the handoff hashes. It copies the complete contract set, launch/source/attestation identifiers, pool, network object and wallet-add parameters into the runtime manifest. The pool ID is derived from the runtime pool key. There is no separate address/chain/RPC map in the application bundle. Protocol interfaces in `src/protocol.ts` are minimal Uniswap interfaces; the deployed hook/token ABIs always come from the manifest.

**Routing conflict:** the legacy workflow requests PoolSwapTest. The mandatory supplied-network requirement restricts every quote, swap and approval to that network's Uniswap addresses; it supplies Universal Router and no PoolSwapTest address. This implementation follows that mandatory constraint: it uses the supplied Universal Router, Quoter and Permit2, with no invented or remembered address. PoolSwapTest is not implemented or claimed as tested. The configured router's code was checked on Sepolia. See [validation](../docs/VALIDATION.md).

## User flows

- Public reads work before connection and continue when connected: `currentRate`, `startBlock`, `blocksLeft`, initialization, token decimals, balances, fee claims and StateView `getSlot0`. A single block number pins each state refresh. The chart follows the implementation's integer rate formula and marks the current elapsed block; after decay its marker stays at the floor and the actual current block remains visible.
- Fee estimates use bigint `floor(input * rate / 10000)`. Exact decimal input rejects excess precision. Hook fees are separate from the displayed pool LP fee; the quoter's output accounts for both. Display formatting is approximate, while amount, quote and transaction arithmetic uses base-unit integers.
- Buy and sell are exact-input swaps. `quoteExactInputSingle` is an `eth_call` simulation, never a wallet transaction. The minimum output is the quote reduced by the user's 0.01–5% slippage. Quotes expire after 45 seconds or more than three observed blocks, and changes to amount/direction/slippage/account/chain invalidate them.
- Native ETH buys need no approval. A sell shows two separate wallet transactions: SNIP approval to Permit2 for the exact amount; Permit2 approval of the supplied router for that amount, expiring after 30 minutes. The approvals are not unlimited.
- Swaps encode command `0x10`, actions `0x060c0f`, and the exact-input tuple followed by `SETTLE_ALL` and `TAKE_ALL`. Native input attaches the exact input value; sells attach zero. Router execution is simulated immediately before requesting a signature. Deadline is five minutes. Hook data is empty because the implementation ignores it and grants no identity credit.
- Both `burnFees` currency actions are exposed. An acknowledgement explains that claims are redeemed permanently to the hook's `DEAD` view, across all pools for that currency. The visitor pays gas; the visitor does not receive the fees. Both calls are simulated. Callback functions are PoolManager-only, and there are no owner/admin/setter operations.
- The activity feed reads `FeeCharged` for the launch pool and `FeesBurned` for its two currencies, in chunks of at most 500 blocks over the latest 2,000 blocks. It shows the latest 12 events; the displayed window is explicit. Empty history, unavailable RPC and loading have distinct messages. Older events are linked through the explorer.
- A missing chain triggers switch → `4902`/unknown-chain detection → the exact supplied `wallet_addEthereumChain` parameters → switch again. Rejections have retry instructions. Account/chain changes, loading, wrong network and transaction receipt state are visible.

Signing stays with the visitor's wallet. Public reads use the supplied RPC list with fallback; transactions require matching RPC chain ID, nonempty deployed code, a matching hook PoolManager, fresh state, the connected chain/account, valid inputs and successful simulation. Checks are repeated before signing. The app does not promise that code-existence checks independently prove bytecode provenance; its addresses/interfaces are bound to the supplied attested handoff.

## Validation

```sh
npm run typecheck --prefix web
npm run test --prefix web
npm run check:export --prefix web
# Install the validation browser once (scratch is not submitted).
PLAYWRIGHT_BROWSERS_PATH="$PWD/test/scratch/browsers" npm exec --prefix web playwright install chromium
PLAYWRIGHT_BROWSERS_PATH="$PWD/test/scratch/browsers" npm run test:browser --prefix web
# Optional, read-only live checks, requiring public RPC access:
npm run check:live --prefix web
PLAYWRIGHT_BROWSERS_PATH="$PWD/test/scratch/browsers" node web/tests/live-browser.mjs
```

Browser scripts serve the production export under `/preview/`, run within one foreground process and close their own preview/browser. `CHROMIUM_PATH` may point to an existing compatible browser. The supplied browser MCP was unavailable; local Playwright was used instead. Evidence is in `docs/evidence/`; mocked screenshots and real-RPC screenshots are explicitly distinguished in the report. No real swap, approval or fee burn was broadcast.

See [design](../docs/DESIGN.md), [validation and limitations](../docs/VALIDATION.md) and [attribution](../docs/INTERFACE-SOURCES.md). The assignment explicitly permits `web/.gitignore`; it excludes dependency/cache/test-output directories at every nesting level below `web/`. Root configuration, contract source and existing ABIs are preserved.
