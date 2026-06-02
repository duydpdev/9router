# Baseline measurements — first-60s perf

Machine: Apple Silicon (arm64), 10 cores, 32GB. Node v22.22.2, Next 16.2.6 (webpack).
Build cmd: `NEXT_TELEMETRY_DISABLED=1 npm run build`.

## Track A — cold start / boot path

Boot-entry ambiguity **resolved by code-path analysis** (not a live server boot —
`npm run start` would spawn cloudflared/MITM and mutate system DNS per saved
`~/.9router` settings; avoided to keep the dev machine side-effect-free, per the
plan risk note that dev-machine timing ≠ user machine anyway).

Findings:
- `src/instrumentation.js` `register()` imported **`@/server-init`, which does
  not exist** → resolved to the `catch`, logging `Module not found: Can't
  resolve '@/server-init'` **every boot** (confirmed in build log line 12). It
  never actually ran init.
- Real init path = `app/layout.js` → `shared/services/bootstrap.js:11` →
  `initializeApp().catch(...)` — **fire-and-forget, not awaited**.
- Inside `initializeApp` (`shared/services/initializeApp.js`) the only awaited
  work is `cleanupProviderConnections()` + `getSettings()` (local SQLite, cheap).
  Everything heavy — tunnel auto-resume, `ensureCloudflared`, `startMitm`,
  watchdog/network monitors, `startWarmupScheduler` — is fire-and-forget
  (`.catch()` / non-awaited) or interval-based.

**Verdict — Phase 4 (init reorder): SKIP.** Init is already off the request
path; no blocking call delays first 200. Only the dead-import cleanup ships.

## Track B — bundle payload (the decisive measurement)

Next 16 (webpack) no longer prints per-route byte columns, so sizes were read
directly from `.next/static/chunks` (raw + gzip).

`rootMainFiles` (shared by all routes): webpack, 4bd1b696, 3794, main-app
→ ~123 KB gz combined. Under the 300 KB gating line on its own.

**But a concrete leak was found.** Chunk `1051-*.js` = **488 KB raw / 150 KB
gz**, containing **recharts + @xyflow/react + d3 + marked**, is `<script>`-loaded
on **every page including `/login` and `/landing`** (verified in
`.next/server/app/login.html`, `landing.html`).

Root cause — **barrel-file leak**: `src/shared/components/index.js` re-exports
`UsageStats`, which **statically imports** `UsageChart` (recharts) and
`ProviderTopology` (@xyflow). Any page importing anything from
`@/shared/components` (e.g. `login/page.js` imports `{ Card, Button, Input }`)
transitively drags both viz libs into its first load. `marked` (site-wide via
`ChangelogModal`) sharing the same merged chunk made the whole bundle load
everywhere.

`/login` first-load chunks (before): 1051(150KB gz), 3794(60.7), 4bd1b696(62.9),
5497(40.8), 1321, 1a258343, 2679, 8407, main-app, webpack, polyfills(39.5).

**Verdict — Phase 3 (bundle diet): PROCEED.** Heavy libs are NOT confined to
their routes; recharts+@xyflow leak site-wide. The "skip if already optimal"
condition fails. Fix: lazy-load `UsageChart`/`ProviderTopology` via
`next/dynamic({ ssr:false })` in `UsageStats.js` to sever the static barrel edge.

## Phase 5 — after-fix re-measure

Same build cmd, same machine. Build **green, and the per-boot
`Module not found: '@/server-init'` warning is gone** (instrumentation now
points at the real bootstrap module).

Bundle (after lazy-loading `UsageChart`/`ProviderTopology`):

| Surface | Before | After | Δ |
|---|---|---|---|
| `/login` first-load JS (gz) | ~408 KB (incl. 1051 chart chunk) | **242 KB** | **−~166 KB (~40%)** |
| recharts location | in site-wide `1051` (150 KB gz, on every page) | async chunk `6725` (100 KB gz / 341 KB raw), `/usage` only | isolated |
| @xyflow location | in site-wide `1051` | async chunks `6357` (27 KB gz / 81 KB raw) + styles, `/usage` only | isolated |
| `1051` chart chunk on `/login`,`/landing`,dashboard home | loaded | **eliminated** | gone |

recharts + @xyflow + d3 no longer load on any page except when the usage view
actually renders them. `/usage` still pulls them — now on-demand via the lazy
chunks (verified the chunks exist on disk and the `next/dynamic` wiring resolves
the default exports).

Tests: warmup **70/70**. vitest 665 pass / 24 skip / **26 fail — all
pre-existing** and unrelated to these changes (RTK `setRtkEnabled` export,
lowdb/cloud-embeddings missing modules, cursor OAuth, translator
normalization). None touch logger / UsageStats / instrumentation / the deleted
page.

Logger: prod default suppresses DEBUG + shows INFO; `LOG_LEVEL=DEBUG` restores
verbosity (both verified by direct module exec).

**Outcome:** Phase 3 delivered a measured win (login first-load −~40%). Phase 4
reorder correctly skipped (init off the request path); dead-import cleanup
shipped (per-boot error eliminated).
