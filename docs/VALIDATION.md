# Frontend validation

Worker self-validation for the Snipeproof frontend on 2026-09-27. These results are evidence of the commands and observations listed below, not independent network certification.

## Scope and requirement resolution

Delivered: React/TypeScript/Vite/wagmi source and lockfile under `web/`, a relative-base static export under `dist/`, implementation-derived ABI arrays and deployment manifest, and documentation/evidence under `docs/`. The deployed Solidity source, root configuration, existing ABI exports, libraries and workflows remain untouched. No publication, deployment, wallet signature or live transaction was performed.

Two requirements cannot be satisfied literally together with the overriding assignment constraints:

1. **Root design document:** root `DESIGN.md` is outside the permitted paths. The implemented design is documented in `docs/DESIGN.md`; no root file was added.
2. **PoolSwapTest:** the legacy workflow requests this router, while the mandatory network criterion requires every swap/quote/approval to use the supplied network's addresses. That network has Universal Router, Quoter and Permit2, and no PoolSwapTest address. The frontend uses those supplied contracts and their verified code. PoolSwapTest behavior is not implemented or asserted. This choice preserves the mandatory network-address constraint.

The page implements the approved user-facing launch actions: exact-input buys/sells, explicit sell approvals, and permissionless ETH/SNIP fee burning. It does not expose manager-only hook callbacks as wallet actions or invent administrator controls. Generic ERC-20 transfer/transferFrom utilities and liquidity management are outside this launch-page flow.

## Checks performed

| Check | Result / evidence |
| --- | --- |
| Initial dependency installation | `npm install --prefix web --cache test/scratch/npm-cache --no-audit --no-fund` completed; exact direct versions and resolved dependencies in the lockfile |
| Clean offline install | `npm ci --prefix web --offline --cache test/scratch/npm-cache --no-audit --no-fund` passed, 538 packages; no vendored registry/cache submitted |
| Typecheck and production build | `npm run build --prefix web` passed; invokes `tsc --noEmit`, Vite and final manifest generation; `evidence/build.log` |
| Protocol unit checks | `npm run test --prefix web`: 5 tests passed; integer fee boundary/rounding, monotonic decay, dust, exact decimals, slippage, both swap encodings, unknown-chain flow and rejection; `evidence/unit-tests.log` |
| Export verification | `npm run check:export --prefix web` passed; exact handoff contract set/identifiers, ABI canonical Keccak, unchanged network/wallet-add parameters, all file SHA-256 hashes and relative paths; `evidence/export-check.log` |
| Mocked production browser | `PLAYWRIGHT_BROWSERS_PATH="$PWD/test/scratch/browsers" npm run test:browser --prefix web` passed; full result and measured contrast in `evidence/browser-results.json` |
| Real-RPC browser read | `PLAYWRIGHT_BROWSERS_PATH="$PWD/test/scratch/browsers" node web/tests/live-browser.mjs` passed; `evidence/live-browser.json` and `evidence/live-desktop.png` |
| Public RPC deployment/quote read | `npm run check:live --prefix web` passed deployment/state reads and buy quote; sell quote returned a revert; `evidence/live-read.json` |

The build has non-fatal third-party PURE-comment warnings and one ~561kB minified entry-chunk warning (~173kB gzip). Installation reports deprecated transitive connectors and an overridden React peer dependency in a transitive package. The selected runtime uses only injected connectors. All required worker build/typecheck/browser checks passed; warnings were not suppressed. A dependency security audit was not performed.

The supplied browser MCP returned `Transport closed` on its first navigation and no tool-managed preview was available. The replacement Playwright scripts own a bounded foreground HTTP server and browser, serve the actual production export at `/preview/`, and close both after the checks.

## Interaction coverage

The production browser test injects an EIP-1193 wallet and intercepts only the configured public RPCs. All wallet writes are fixtures. It decodes transactions against the same ABIs and asserts recipients, calldata and native value.

- Disconnected and missing-wallet recovery; wallet rejection; wrong chain with disabled actions; code 4902 followed by the exact supplied add-chain request and another switch.
- Invalid/scientific/excess-precision input and insufficient balances; invalid slippage; output quote and minimum received; quote request through the form keyboard path.
- Buy transaction simulation failure blocks a signature; wallet rejection is recoverable; successful mocked buy uses the configured Universal Router and exact native input. The buy action also executes by Enter.
- Sell token allowance and Permit2 allowance are separate exact-amount transactions, with correct configured spenders and 30-minute expiry. Successful mocked sell sends zero native value.
- Both fee burns require acknowledgement, use the loaded hook ABI and correct currency, and refresh claims after a successful receipt.
- Quote expiration at 45 seconds, invalidation after amount edits and external account disconnection. Code also enforces the three-observed-block limit and checks wallet chain/account immediately before signing.
- Decoded `FeeCharged` and `FeesBurned` fixtures appear with currency units, event type, block and explorer link; failed event reads do not masquerade as empty history.
- Missing router code, RPC failure and tampered ABI disable relevant paths and show recovery/error states.
- No page JavaScript errors or failed static-resource requests in the successful mocked run. Real-browser RPC reads also had no console errors or failed requests in their recorded run.

## Better Interface consolidated review

The pinned workflow and the core principles of all six domains were read and applied. Source review supplements rendered evidence. References and upstream attribution are in `INTERFACE-SOURCES.md`.

| Domain | Coverage | Evidence and limits |
| --- | --- | --- |
| Accessibility | **Checked** | Native controls, labels, `aria-pressed`, field associations, stable status/alert, SVG description, skip navigation, focus CSS and reduced motion. Keyboard submission and focus screenshot; axe WCAG A/AA scan found zero violations. No screen-reader session or physical-device accessibility test; focus was not manually viewed at every stop. |
| Layout | **Checked** | Actual export at 1440, 900, 800, 390 and 320 CSS pixels, including expanded identifiers; no page overflow. Desktop 200% root text enlargement checked. Native browser 200% zoom not tested. RTL and localization are not implemented and not applicable. |
| Writing | **Checked** | Action labels match simulation/approval/swap/burn consequences. Hook fee is distinct from LP fee, quote minimum from spot price, claims from wallet balances. RPC failure differs from empty data; irreversible fee destination and gas are stated. |
| Typography | **Checked** | Source scale, 16px+ input sizes, tabular values, wrapping identifiers; desktop/mobile screenshots reviewed. System fonts only; exact font family depends on the visitor's OS. |
| Colors | **Checked** | Semantic tokens and actual computed solid foreground/background pairs measured: body/paper 13.86:1, muted/paper 5.58:1, white/primary green 11.82:1. Axe scan supplements these selected measurements. No dark theme, photographic backdrop or every-state contrast certification is claimed. |
| UI | **Checked** | Selected/disabled/pending/error/empty/success states exercised; native disclosure and explicit approval steps. Button transitions disabled under reduced motion. No dialogs or entrance animations; 10%-speed animation-panel inspection is not performed. |

### Findings, corrections and rechecks

| Severity | Source | Finding / evidence | Resolution |
| --- | --- | --- | --- |
| Medium | `web/src/style.css:1040` | In the initial desktop screenshot, the refresh-quote and swap buttons touched, obscuring their separation. | Added 12px between consecutive form buttons. Rebuilt and viewed the final desktop quote screenshot. |
| Medium | `web/src/style.css:1005` | Initial 320px screenshot scaled SVG tick labels down too far for comfortable reading. | Increased narrow-screen SVG tick and marker label sizes; checked the final 320px image. HTML current fee/block equivalents remain available. |
| Low | `web/src/style.css:1043` | The unfocused, translated skip link appeared in full-page screenshots taken from a scrolled position. | Clipped it while unfocused; retained focus visibility and verified the final screenshot/focus state. |
| Medium | `web/src/chain.ts:185` | Initial event implementation read `FeeCharged` only; hook redemptions were missing from observability. | Included `FeesBurned`, labeled its currency-wide scope and filtered to the two currencies; decoded-event interaction test passes. |
| Low | `web/src/style.css:683` | A broad event-span alignment rule aligned event labels with amounts rather than their block links in the mobile screenshot. | Restricted end alignment to direct value spans; rechecked the mobile event feed after rebuilding. |
| Medium, prevented during implementation | `web/src/App.tsx:197` and `web/src/App.tsx:356` | A signed action could otherwise reuse a quote after account/input/time changes. | Snapshot quote inputs/account, revision guard for late responses, TTL/block limit, fresh data, simulation and wallet recheck. Amount/account/TTL/signature gates are covered by the interaction suite. |

### Rendered evidence

- `evidence/desktop-quote.png`: **mocked** connected buy quote at 1440px, mid-decay fixture, explicit minimum output.
- `evidence/mobile.png`: **mocked** disconnected sell form and event feed at 390px.
- `evidence/mobile-320.png`: **mocked** 320px reflow and enlarged chart labels.
- `evidence/keyboard-focus.png`: **mocked** visible keyboard focus perimeter.
- `evidence/live-desktop.png`: **real public RPC** state, disconnected wallet, no transactions. It is not proof of a live swap.

## Live-chain observations and limits

The read-only script pinned block **11,791,645**. Chain ID was 11155111. Both application contracts and all six supplied Uniswap addresses had nonempty code; the Universal Router had 19,540 bytes. Hook `poolManager` matched the handoff. Pool ID was `0xb914699d167d31cb4f356da3c0335393ff311089f9bbd0495df0dee85c239d45`. The pool was initialized at block 11,791,437; its rate was 3,967 bps with 792 blocks left. The ETH-input quote for 0.0001 ETH returned approximately 2,994.1766 SNIP. A 1 SNIP sell quote reverted on all three configured RPCs. The exact read inputs, result values and endpoint failures are retained in `evidence/live-read.json`; replay uses `node web/scripts/check-live.mjs 11791645` (without a block argument it obtains a new current block).

The separate real browser read observed block **11,791,695**, rate **37.18%**, **742** blocks left and StateView price **50,000,000 SNIP/ETH**. This is a live pool price, not the manifest's initial price. These values are observations at those blocks, not promises about later state. Real wallet transaction signing, approvals, router execution, burns, mined swap economics and mobile wallet applications remain **unperformed**. The reverted sell quote is not represented as successful live-chain trading. The application surfaces simulation failures and does not enable bypasses.

No site publishing, IPFS pinning, site naming or subsequent control-plane checks were attempted or claimed. The deployed handoff's ABI hashes are checked; the worker does not independently issue a deployment attestation.

## Completion

**Complete for the permitted frontend scope with the two explicit requirement conflicts recorded above.** Source, lockfile, production export, manifest and validation evidence are present in the worktree. The repository `.git` directory is mounted read-only: `git add` failed creating `.git/index.lock`, so no commit could be created in the worker repository. A disposable scratch clone is used only to validate the complete submission bundle size; the publisher must capture/commit the delivered worktree changes. The literal root `DESIGN.md` and PoolSwapTest criteria remain superseded by the overriding write scope and mandatory network-address requirement. Live transaction behavior is documented as untested. The publisher may now perform source publication, hosting and the separate deployment/asset checks.
