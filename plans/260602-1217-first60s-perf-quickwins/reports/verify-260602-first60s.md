# Verify report — first-60s perf + quick wins

Date: 2026-06-02. Branch: feat/implement-sercurity. Machine: arm64 10-core, Node v22.22.2, Next 16.2.6 (webpack).

## What shipped

| Phase | Item | Result |
|---|---|---|
| 2 | Delete dead `providers/[id]/page.new.js` (1724 lines) | Done — zero importers, build green |
| 2 | Logger env-gate (`LOG_LEVEL`, prod→INFO default) | Done — verified prod hides DEBUG, `LOG_LEVEL=DEBUG` restores |
| 2 | Doc `LOG_LEVEL` in README + `.env.example` | Done |
| 3 | Lazy-load `UsageChart`+`ProviderTopology` (`next/dynamic ssr:false`) | Done — **PROCEED** verdict (concrete leak) |
| 4 | Dead `@/server-init` import → repoint to bootstrap | Done — per-boot error eliminated |
| 4 | `initializeApp` reorder | **Skipped** — verified init already fire-and-forget, off request path |

## Headline numbers

- `/login` first-load JS: **~408 KB → 242 KB gz (−~40%)** by evicting recharts/@xyflow/d3.
- Site-wide `1051` chunk (150 KB gz of chart libs, previously on login/landing/every page): **eliminated**.
- recharts → async `6725` (100 KB gz), @xyflow → async `6357` (27 KB gz) — `/usage`-only, on render.
- Build: green; `Module not found: '@/server-init'` per-boot warning **gone**.

## Root cause (Phase 3)

Barrel-file leak: `src/shared/components/index.js` re-exports `UsageStats`, which
statically imported `UsageChart` (recharts) + `ProviderTopology` (@xyflow). Any
page importing from `@/shared/components` (e.g. `login/page.js`) transitively
dragged both viz libs into first load. Converting the two imports to
`next/dynamic({ssr:false})` in `UsageStats.js` (the sole consumer) severed the
static edge.

## Tests

- `npm run test:warmup`: **70/70 pass** (boot/init ordering — directly relevant to Phase 4).
- `npm test` (vitest): 665 pass / 24 skip / **26 fail**.
  - All 26 failures **pre-existing**, unrelated to this session's edits:
    RTK compression (`setRtkEnabled` missing export ×9), missing modules
    (lowdb, cloud embeddings ×2), cursor OAuth ×5, translator normalization ×4,
    codex token, header forwarding, openai response, provider dedupe.
  - None touch logger / UsageStats / instrumentation / deleted page.

## Code review

`code-reviewer`: 0 critical/high/medium. All acceptance criteria verified
empirically (nullish `??` on DEBUG=0, double-init guards, barrel severance,
ssr:false safety, zero-importer delete, eslint clean on edited files).

Two LOW (optional) findings:
1. Invalid `LOG_LEVEL` value silently falls back to env default (no warning). Optional hardening.
2. **Pre-existing:** `logger.warn()` has its `console.warn` commented out → WARN
   logs print nothing in all envs. The new prod-INFO default makes `LEVEL<=WARN`
   true, so WARN is *reachable* but still silent — contradicts the plan's stated
   "keep INFO/WARN/ERROR visible". 1-line uncomment fix; left out of scope
   (surfaced to user for decision).

## Manual smoke (not run headless)

Build-level verification only: lazy chunks exist on disk, `next/dynamic` resolves
default exports, `/usage` HTML wiring intact. Live browser smoke of `/usage`
(chart+topology render after lazy load) recommended before release but not
performed in this session.

## Unresolved questions

1. Uncomment `logger.warn()`'s `console.warn` (align with plan's WARN-visible intent)? — out of scope this round; awaiting user.
2. 26 pre-existing vitest failures predate this work — separate triage.
