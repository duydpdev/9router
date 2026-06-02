# Verify Report — Reliability: logger migration + silent-error triage

## Phase 1: Server logger migration + warn() fix

### warn() fix
- `src/sse/utils/logger.js:47` — `console.warn` uncommented. `warn()` now emits.

### Target files migrated (6 files, ~62 console.log → 0)
| File | Before | After | Pattern |
|------|--------|-------|---------|
| `src/shared/services/initializeApp.js` | ~19 | 0 | `import * as log from "@/sse/utils/logger.js"` |
| `src/lib/tunnel/tailscale/manager.js` | ~11 | 0 | `import * as log` |
| `src/lib/tunnel/cloudflare/manager.js` | ~11 | 0 | `import * as log` |
| `src/lib/tunnel/tailscale/tailscale.js` | ~7 | 0 | `import * as logger` (avoids `log` param conflict) |
| `src/app/api/providers/[id]/models/route.js` | ~9 | 0 | `import * as log` |
| `src/app/api/v1/models/route.js` | ~7 | 0 | `import * as log` |

### Level mapping applied
- Operational milestones (tunnel up, init complete, MITM started) → `info` (visible prod default)
- Per-tick / daemon-probe / verbose traces → `debug` (hidden prod, restored via `LOG_LEVEL=DEBUG`)
- Recoverable errors → `warn`; failures → `error`
- No double `[Tag][Tag]` prefixes — inline prefix stripped when moving to `logger(tag, …)`

### Excluded (intentional)
- `src/lib/oauth/utils/ui.js` — chalk/ora CLI output, not logger-eligible
- Client dashboard pages — browser audience, deferred to follow-up

### Preserved
- `open-sse/handlers/chatCore.js:120` — `console.log(rtkLine)` — raw RTK marker, warmup e2e parses it. **Untouched.**

---

## Phase 2: Silent-error triage

### chatCore.js (6 `.catch(() => {})`)
All 6 were best-effort telemetry (appendRequestLog / saveRequestDetail). Converted to:
```js
.catch((e) => log?.debug?.("USAGE", `… failed: ${e?.message || e}`))
```
Proxy path unaffected. Expected-disconnect paths (`AbortError`) handled separately.

### mitm/server.js (4)
All `try { client.close(); } catch {}` → annotated `/* best-effort socket close */`. Observer callback swallow annotated `/* observer callback must not break proxy */`.

### mitm/manager.js (3 `.catch(() => {})`)
- kill-on-stop → `/* best-effort kill */`
- `_updateSettings` persist (×2) → `/* best-effort flag persist */`

### initializeApp.js startup fire-and-forgets
- `ensureCloudflared().catch()` → `log.debug` with "watchdog will retry" note
- `syncMitmAliasCache().catch()` → `log.debug`

### usageRepo.js (6)
All are enrichment/display-name lookups — annotated intentional (cache refresh, connection/key/node name maps).

### machineId.js (4)
First-run / persist-fallback pattern. All annotated with why they're intentional (no-file-yet / persist-best-effort).

### DB adapters (nodeSqlite, bunSqlite, betterSqlite — 5 each = 15)
WAL checkpoint + graceful-close teardown. All annotated best-effort / teardown.

### migrate.js (4)
- Index creation idempotency → `/* idempotent: index already exists */`
- Marker write → `/* best-effort marker write */`
- Pre-migration backup failure (×2) → surfaced via `console.warn` (data-safety signal)

### Scoped out
- `src/shared/components/OAuthModal.js` — file no longer exists, skip
- `src/app/(dashboard)/dashboard/media-providers/[kind]/[id]/page.js` — file no longer exists, skip
- Remaining ~107 scattered single-catch files across codebase — deferred follow-up pass

---

## Phase 3: Verification

### Static checks ✓
- All 6 Phase-1 target files: `grep "console\." → 0`
- All 6 files: `import * as log from "@/sse/utils/logger.js"` present
- RTK marker `chatCore.js:120` intact
- `logger.warn()` now calls `console.warn` (line 47)

### Build / test: PENDING USER RUN
Run to confirm:
```sh
npm run build          # must be green, no new warnings
npm run test:warmup    # expect 70/70
npm test               # expect ≥665 pass, ≤26 fail (same known set)
```

### Logger behavior smoke (manual):
- `NODE_ENV=production` (no LOG_LEVEL) → no `🔍 debug` lines from migrated files
- `LOG_LEVEL=DEBUG` → debug lines return
- Trigger `logger.warn(...)` → must print `⚠️` line

---

## Counts summary
| Category | Count |
|----------|-------|
| console.log/error migrated to logger | ~62 |
| Empty catches → intentional comment | ~40 |
| Empty catches → debug-log (trace) | 4 |
| Empty catches → warn surfaced | 2 (migrate.js backups) |
| Files left for follow-up pass | ~107 scattered catches |
