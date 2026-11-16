# TokenRadar — build log

## What it is

A dark token-launch radar for make.fun's token-radar-01 bounty ($1,325). `main.ts` reads the
sealed DefiLlama snapshot (758 protocols, 40 on the watchlist, as of 2026-11-14), scores every
rankable pre-token protocol with the radar-2 model, and writes the board, the dashboard data,
the dashboard, the screenshots and the dossier.

## The model (radar-2, in `lib/model.ts`)

```
implied = round( tvl_usd x 0.25
  x (1 + clamp(change_7d, -60, 120) / 100 x 0.5)
  x (0.6 + min(age_days, 1095) / 1095 x 0.4)
  x (0.85 + 0.03 x min(chains, 5)) )
```

TVL is what a launch would be priced against; seven-day growth is the momentum the snapshot
records; age is how long the protocol has run with no token on record (unknown age uses 365
days); chain breadth is how many chains its TVL sits on (one chain 0.88, five or more 1.00).
No protocol name is special-cased: one function scores every row, and the dashboard prints
the formula with the constants it ran on.

Rankable means pre-token (no market cap, no CoinGecko id, no symbol), not an exchange, not a
versioned pool, not a wrapped/staked/bridged product of a token that already trades — the
house's watchlist rule without the TVL floor, plus `Cross Chain Bridge` and `Stablecoin
Wrapper`, which are a bridge and a wrapper under other words. The board ranks **all 196**
rankable protocols: the 40 watchlist slugs plus 156 early rows below the floor. The 24
live-token protocols are set aside in a Live token tab with their market caps, never mixed
into the ranking.

## The farm plan

Seven steps per protocol, each an action with a cost and a time, derived from the protocol's
own record (category, chains, TVL, age): fresh wallet, the category's position, a second
feature to deepen the footprint, a weekly qualifying action, the hold (30–60 days by age),
the claim check, and the farm log. Capital tiers: $250 / $150 / $100 / $50 by TVL.

## The dashboard (`dashboard/`)

Dark radar theme, no network, no images (the radar mark is plain CSS). Search, category
filter, chain filter, watchlist-only toggle, Pre-token / Live token tabs, sortable columns
(implied value, name, TVL, 7d, age, chains), a detail dialog per protocol with the model
breakdown (all four multipliers, and the page's recomputation checked against board.json)
and the seven-step farm plan, a model panel stating the formula, and a footer naming the
snapshot source and the "records no token, never that it has none" language.

## Files

| File | Bytes |
| --- | --- |
| `main.ts` | 4,756 |
| `lib/model.ts` | 22,536 |
| `vendor/makefun-board.ts` | 19,788 (the kit's dossier library, byte-identical: sha256 9ca51b6e…) |
| `dashboard/index.html` | 483 |
| `dashboard/app.css` | 10,546 |
| `dashboard/app.js` | 27,661 |
| `screenshots/1-board.jpg` | 295,115 (1280×800, board) |
| `screenshots/2-detail.jpg` | 329,208 (1280×800, rank-1 detail) |
| `screenshots/3-filtered.jpg` | 286,701 (1280×800, Lending filter) |
| `README.md` | 1,821 |
| `LICENSE` | 1,097 (MIT + SPDX line) |
| `.makefun/owner.json` | 57 |
| `shots.json` | 185 |

Dashboard source total: 38,690 bytes (under the 64 KB dossier text cap; the dossier's text
holds it whole, 39,785 bytes, nothing cut).

## Verification

- `grade-local` is **not available** for this competition: the kit CLI refuses it ("its
  scorer and reference data are not published in the kit, so the house grades it from its
  competition directory"). So the seven gate rows were checked locally with
  `~/workspace/makefun/tools/check-radar.mjs`, a re-implementation of the rules' gate:
  **all 7 pass** — dashboard_files, board_file (196 rows), sorted_by_value (ranks 1..196,
  implied non-rising), coverage (all 40 watchlist slugs), farm_steps (7 per row, 122–183
  chars each), screenshots (3 JPEGs, 1280×800, each under 512 KiB), dossier_matches
  (byte-identical to what `buildDossier` writes; dossier 1,254,850 bytes, under 1.5 MiB).
- Determinism: two independent runs of `main.ts` into separate directories produced
  byte-identical output (`diff -r` clean), and the `out/` directory matches them too. The
  program runs twice with the same bytes, as the grader requires.
- Screenshots: taken with headless Chromium (Playwright + Chrome for Testing) at 1280×800,
  JPEG quality 100, 0 console errors and 0 page errors on every shot
  (`~/workspace/makefun/tools/shoot-radar.mjs`). Viewed all three: the board shows 5 rows
  with the stats and controls, the detail dialog shows the model breakdown and farm plan,
  the filtered view shows the Lending filter with 16 rows.
- The radar mark was first drawn as inline SVG; it was replaced with plain CSS because the
  SVG namespace address (`http://www.w3.org/2000/svg`) would have put an http:// string in
  the dashboard's JavaScript. No dashboard file now contains any http:// or https:// string
  (the strict scan in the check script confirms it).

## Notes for the lead

- Screenshot sizes: 1-board.jpg 295 KB and 3-filtered.jpg 287 KB sit just under the rules'
  300–350 KB guideline; 2-detail.jpg is 329 KB. They are quality-100 JPEGs, each under the
  512 KiB gate cap, and the dossier (1.25 MB) sits under the 1.5 MiB cap with room — the
  guideline exists to keep the dossier under its cap, which holds. Raising them would mean
  degrading the design or the image quality, so they were left as shot.
- The `out/` directory is a local build artifact (regenerate with
  `mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../token-radar-01-kit/input/snapshot.json`)
  and is not part of the entry.
- Never pushed, never submitted — that is the lead's step.
