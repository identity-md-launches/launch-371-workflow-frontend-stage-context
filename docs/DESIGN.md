# Snipeproof design

## Overview

A launch observatory for Sepolia visitors who want to understand the current input fee before trading. The implemented page uses warm paper, dark green text, a prominent fee curve, and a single white swap panel. The hierarchy is: launch explanation, current state, swap, observable fee activity, then deployment details. This visual direction was inferred for the assignment.

Source: `web/src/style.css`, `web/src/App.tsx`. This document lives under `docs/` because the overriding write scope prohibits the requested repository-root `DESIGN.md`.

## Colors

The canonical format is sRGB hex. Primitives and semantic aliases are in `web/src/style.css:1`.

| Semantic token | Primitive/value | Use |
| --- | --- | --- |
| `--page` | `--paper`, `#f7f7f2` | Page background and inset fields |
| `--surface` | `--white`, `#ffffff` | Swap panel, inputs, selected direction |
| `--subtle` | `--stone-100`, `#eeeee6` | Segmented rail, hover and disabled surfaces |
| `--text` | `--forest-950`, `#182b24` | Body, headings, changing numbers |
| `--muted` | `--stone-700`, `#5c665a` | Supporting text and labels |
| `--border` | `--stone-300`, `#d4d7cc` | Structural dividers and panel edges |
| `--control-border` | `--stone-500`, `#818779` | Available controls |
| `--accent` | `--forest-900`, `#203d33` | Primary action and fee curve |
| `--accent-ink` | `--white`, `#ffffff` | Primary action label |
| `--highlight` | `--lime-200`, `#d8edac` | Fee area at 50% opacity, brand mark |
| `--focus` | `#305fba` | Three-pixel focus perimeter |
| `--error` | `--red-800`, `#9d302a` | Error text and outline |
| `--error-bg` | `--red-50`, `#fff2ed` | Error surface |

Measured rendered contrast pairs are recorded in `evidence/browser-results.json`. The first rendered audit measured body/paper 13.86:1, muted/paper 5.58:1 and primary white/green 11.82:1; the final audit records the same source roles. There is one light theme. There are no decorative images or opaque color claims over photographs. Status always includes text.

## Typography

The local system stack is `Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`; no font downloads or third-party font service are used. Inter is only used if installed. The exact local fallback family varies by browser and OS; no custom font availability is claimed. Monospace identifiers use `ui-monospace, SFMono-Regular, Consolas, monospace`.

The root is 16px with 1.5 line height. Body, small and label tokens are 1rem, .8125rem and .75rem. Headings use a tighter line height and balanced wrapping; `h1` scales from 2.6rem to 4.75rem with -0.055em tracking, then uses 3.5rem below 800px and 2.75rem below 500px. Ordinary section `h2` is 1.35rem, the activity heading is 1.8rem, and `h3` is 1rem. The fee number uses 4.4rem, with responsive reductions. Weights range from 400 to 750; the system font determines supported rendering. Tabular numerals are global. Addresses and hashes wrap anywhere and are selectable.

Form text inputs remain at least 16px; the amount input is 1.9rem. Long explanatory text uses constrained widths, e.g. 480px for the hero description. Small-screen chart labels are enlarged inside the SVG so they remain legible as the chart scales. The chart also has a title, descriptive accessible text and equivalent current-rate/block values in HTML.

## Layout

`.wrap` is at most 1200px with 40px side gutters, reducing to 24px below 1000px and 16px below 500px. Spacing uses mainly 8, 12, 16, 24, 32 and 48px. `.workspace` and `.activity-grid` use a 1.5fr/1fr desktop split with a 48px gap, narrowed at 1000px, then become one column below 800px. In the single column, the swap panel is centered and capped at 560px. Reading order remains DOM order.

Below 800px the supplementary hero note is hidden; its content is redundant with the deployment explanation. Below 500px header controls wrap, deployment details become one column, and the footer flows into multiple lines. The metrics and chart remain visible. Disclosure uses native `<details>`/`<summary>`.

The export was exercised at 1440, 900, 800, 390 and 320 CSS pixels, including expanded deployment details. Tests also cover desktop 200% root text enlargement; this is distinct from native browser zoom. There is no RTL/localization variant.

## Elevation & Depth

The layout is mostly flat. The swap surface has a 1px border and a restrained `0 5px 16px #182b2405` shadow. Tonal field backgrounds group form content. Dividers separate major sections, state and price. No modal, sticky transaction bar, background image or animated entrance is used.

## Shapes

The outer swap card uses `--radius: 16px`. Buttons have 8px radii; inset fields and the segmented rail have 10px radii. Tags are pill-shaped. Focus outlines are 3px with a 4px offset. Interactive target heights are generally 44px; segmented buttons use 40px. Buttons never meet the viewport edges. Consecutive quote/swap buttons have a 12px gap.

## Components

- `Curve` in `web/src/App.tsx`: SVG curve with native accessible title/description, grid, start-to-floor block ticks and current-block marker. At elapsed blocks above 1,000 the marker stays at the endpoint and the caption explains the floor. The actual current block remains visible above the workspace.
- `.metrics`, `.hero-number`, `.price-row`: tabular onchain values with persistent labels; unavailable values use an em dash, not fabricated data.
- `.segmented`: two native buttons with `aria-pressed` for buy/sell. Selection is visible without relying on color alone.
- `.amount-field`, `.slippage-row`: visibly labeled, keyboard-operable fields; input errors are associated using `aria-describedby` and `aria-invalid`. The slippage input has a separate percent unit.
- `.primary`: one currently relevant filled action within the swap flow; neutral peer actions use the default button or `.secondary.full`. Disabled actions explain missing prerequisites in nearby state text. Pending operations prevent duplicates.
- `.transaction-feedback`: stable polite status, persistent alert and transaction explorer link. Quotes display minimum output and expiry. Rejections are recoverable.
- `.burn-panel`: claims grouped by currency, acknowledgement checkbox, explicit permanent destination and separate native/token burn buttons.
- `.event-list`: latest scoped charges and currency-wide burns with units, block and explorer links. Empty and RPC-error states are separate.
- `.deployment`: native disclosure containing full contract identifiers and source binding. No custom focus trap is necessary.
- `.skip` and `:focus-visible`: skip navigation and a visible perimeter for keyboard users. The unfocused skip link is clipped; it appears on focus. Forced colors preserve system focus color.

Motion is limited to 120ms background/color/transform transitions and `scale(.96)` button press feedback, only under `prefers-reduced-motion: no-preference`. Reduced-motion mode is static.

## Do's and Don'ts

Reuse the semantic tokens and `.wrap` before introducing layout values. Keep one emphasized action in the swap step and retain the fee/minimum output context. Keep exact transaction arithmetic separate from approximate display formatting. Add new state messages with recovery instructions and native controls.

Do not hide stale data, reuse an old quote after edits, encode meaning only through color, or replace the native disclosure with a custom overlay without a demonstrated need. Preserve the 16px minimum form text and full selectable identifiers. A future section should start with a semantic heading, reuse the section/field/button patterns, and pass the same 320px reflow and keyboard checks.
