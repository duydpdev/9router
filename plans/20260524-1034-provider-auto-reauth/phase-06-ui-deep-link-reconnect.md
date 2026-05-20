---
phase: 6
title: "UI deep-link reconnect + needsReauth badge"
status: pending
priority: P2
effort: "4-6h"
dependencies: [1, 5]
---

# Phase 6: UI — needsReauth badge + deep-link reconnect

## Overview

Surface `needsReauth` state in the dashboard and make the deep-link from the notification auto-open the OAuth flow for the correct connection. Two surfaces touched: the Providers index page (list + status badges), and the per-provider detail page (`/dashboard/providers/[id]`).

## Requirements

- Functional
  - Status display logic recognizes `needsReauth=true` as a distinct UI state — badge "Needs Reauth" (variant `warning`/`amber`), separate from generic "Error" or "Expired".
  - Each `ConnectionRow` shows a "Reconnect" primary button when `needsReauth=true`.
  - Per-provider page `/dashboard/providers/[id]` reads `?reconnect=<connectionId>` from URL. If present AND it matches an existing connection on this page → auto-trigger the existing OAuth flow for that connection. After triggering once, scrub the query param from the URL so refresh doesn't re-fire.
  - Deep-link from notifier targets `/dashboard/providers/<provider>?reconnect=<connId>` — note `<provider>` here is the provider id, which is the same path segment as `[id]`. Verify the existing route accepts the provider id.
- Non-functional
  - Auto-trigger only runs when the user is already authenticated to the dashboard (JWT cookie present) — the existing `dashboardGuard.js` handles this.
  - No new endpoints — reuses existing `/api/oauth/[provider]/authorize` etc.
  - Reconnect must update the SAME connection row (not create a new one). Phase 7 handles the persistence side.

## Architecture

```
Deep-link arrives → /dashboard/providers/claude-code?reconnect=abc-123
   ├── useSearchParams() reads reconnect=abc-123
   ├── useEffect runs once:
   │     1. find connection with id === abc-123 in this page's connection list
   │     2. if not found → toast "Connection no longer exists"
   │     3. if found → call existing handleConnect(connection) (same handler the
   │        "Reconnect" button uses)
   │     4. router.replace(currentPath) to strip the query
   └── handleConnect opens the OAuth window (existing flow):
         - PKCE/device-code → /api/oauth/<provider>/authorize → user IdP login
         - Callback → /api/oauth/<provider>/exchange (Phase 7 makes this clear
           the needsReauth flag and re-fetch projectId)
```

UI states (per `ConnectionRow`):
- `effectiveStatus === "needs_reauth"` → amber badge "Needs Reauth", primary button "Reconnect", show `reauthReason` and `reauthAt` in a small tooltip / detail line.
- Existing `expired` / `error` / `unavailable` statuses remain as-is.
- Effective status precedence: `needs_reauth` > `expired` > `unavailable` > `error` > `active`.

## Related Code Files

- Modify: `src/app/(dashboard)/dashboard/providers/page.js`
  - `getStatusDisplay()` (line 30–50) — recognize `needs_reauth`
  - `getConnectionErrorTag()` (line 55–94) — add `reauth_required` branch returning tag `"REAUTH"`
  - `getEffectiveStatus()` (callers around 180–204) — return `"needs_reauth"` if `needsReauth=true`
- Modify: `src/app/(dashboard)/dashboard/providers/components/ConnectionsCard.js` (lines 32–197 `ConnectionRow`)
  - status badge + tooltip
  - new "Reconnect" button (or change existing button label when in needs-reauth state)
- Modify: `src/app/(dashboard)/dashboard/providers/[id]/page.new.js`
  - Add `useSearchParams` hook to read `?reconnect=`
  - Add `useEffect` to auto-trigger reconnect on mount/param change
  - Add same status logic to its inline `ConnectionRow.js`
- Modify: `src/app/(dashboard)/dashboard/providers/[id]/ConnectionRow.js` — same badge / button changes
- Modify: `src/shared/utils/getEffectiveStatus.js` (or wherever the helper lives — see scout report line 95) — add `needs_reauth` branch
- Create: `tests/ui/needs-reauth-status.test.jsx` (Playwright/React Testing Library — use whatever the repo already uses; if no UI test infra exists, fall back to a component-level integration smoke and manual-test checklist)

## TDD — failing tests first

UI tests (or manual checklist if framework not present):
1. Connection with `needsReauth=true, reauthReason="invalid_grant"` → renders amber "Needs Reauth" badge.
2. Tooltip on badge shows `reauthReason` + relative time of `reauthAt`.
3. "Reconnect" primary button renders next to the badge.
4. Connection with `needsReauth=false` → no badge, no button (unchanged).
5. Visiting `/dashboard/providers/claude-code?reconnect=abc-123` when connection `abc-123` exists → triggers `handleConnect` exactly once.
6. Same URL when `abc-123` does NOT exist on this page → toast appears, no OAuth window opens.
7. After auto-trigger, URL has the `?reconnect=` param stripped.
8. Auto-trigger fires only once even if React re-renders.

If repo lacks React testing setup, ship #1–#4 as a unit-level test of the badge logic helper, and #5–#8 as a manual-smoke checklist in `plans/20260524-1034-provider-auto-reauth/test-plan.md`.

## Implementation Steps

1. **Write failing tests / checklist** items 1–8. Confirm red.
2. Add `needs_reauth` to the status helper chain (page.js + ConnectionsCard + per-provider page). Centralize a tiny `getEffectiveStatus(conn)` helper if duplication appears.
3. Render the amber badge + tooltip + Reconnect button in both `ConnectionRow` components. Reuse the existing `<Badge variant="warning">` if available.
4. In `[id]/page.new.js`, add:
   ```js
   const searchParams = useSearchParams();
   const router = useRouter();
   const reconnectId = searchParams.get("reconnect");
   const triggeredRef = useRef(false);

   useEffect(() => {
     if (!reconnectId || triggeredRef.current) return;
     const conn = connections.find(c => c.id === reconnectId);
     if (!conn) {
       notify.error("Connection not found");
     } else {
       triggeredRef.current = true;
       handleConnect(conn);
     }
     router.replace(window.location.pathname);
   }, [reconnectId, connections]);
   ```
5. Verify the existing `handleConnect` flow accepts a connectionId for re-auth (vs only "create new"). If the flow currently always creates a new row, defer this nuance to Phase 7 where the OAuth callback writes back to the existing row.
6. Run tests / walk through the manual checklist.

## Success Criteria

- [ ] Connection with `needsReauth=true` renders amber badge + Reconnect button on both list and detail pages.
- [ ] Deep-link `?reconnect=<id>` auto-opens the OAuth flow for that exact connection.
- [ ] Query param stripped from URL after auto-trigger.
- [ ] Toast on missing connection id.
- [ ] No visual regression for healthy / locked / errored connections.

## Risk Assessment

| Risk | Mitigation |
| ---- | ---------- |
| `handleConnect` today creates a brand-new row instead of updating the existing one | Phase 7 makes the OAuth exchange update the existing row by `connectionId` (passed through OAuth `state` param). UI need not change. |
| User opens deep-link from a session that isn't authenticated to the dashboard | Existing `dashboardGuard` redirects to login. After login, URL preserved by Next.js Auth flow — user lands back on the deep-link page and trigger fires. |
| OAuth window blocked by browser pop-up blocker | Existing flow already handles this — re-uses the user-triggered button click. Auto-trigger via useEffect may NOT count as user-gesture in some browsers. Acceptable: user clicks the visible "Reconnect" button manually if auto-trigger is blocked. The notification deep-link first reaches the page, and the visible button is the fallback. |
| `searchParams` race with React Strict Mode double-effects | `triggeredRef` guards single-trigger. |

## Next Steps

Phase 7 ensures the OAuth callback writes back to the existing connection row (matched by `state` param carrying `connectionId`), clears `needsReauth`, and re-fetches the project ID for antigravity / gemini-cli.

## Red Team Adjustments — 2026-05-24

Findings **F5, F9** accepted. Canonical file fix + non-refresh-capable providers special-cased.

### F5 — Modify `page.js`, NOT `page.new.js` (CRITICAL)

Next.js App Router only serves files named exactly `page.js` / `page.jsx` / `page.tsx`. `src/app/(dashboard)/dashboard/providers/[id]/page.new.js` is DEAD CODE (1724 lines, zero importers — verified via `grep -rn 'page\.new' src/`). All Phase 6 UI work going into `page.new.js` is invisible to users.

**Pre-flight verification (run BEFORE any Phase 6 edit):**
```bash
grep -rn "page\\.new" src/                                # must return 0
ls src/app/\(dashboard\)/dashboard/providers/\[id\]/      # confirm page.js exists
```

**Corrected "Related Code Files":**
- Modify: `src/app/(dashboard)/dashboard/providers/[id]/page.js` (canonical route — was incorrectly listed as `page.new.js`)
- Optional cleanup: delete or rename `page.new.js` if it's stale scratch — coordinate with the original author via `git log` for that file.
- Modify: `src/app/(dashboard)/dashboard/providers/[id]/ConnectionRow.js` (verify which ConnectionRow `page.js` actually imports — there may be more than one)

**Tests must assert against the rendered `page.js`** (not `page.new.js`). Add pre-flight assertion: import path of the active route resolves to `page.js`.

### F9 — Cursor / GitLab PAT / Codex import / iFlow cookie have no OAuth refresh (HIGH)

Cursor has `refreshToken: null` (no public refresh endpoint per `src/app/api/oauth/cursor/import/route.js:47`). Auto-import is LOCAL_ONLY_PATHS (loopback per `src/dashboardGuard.js:82-84`). Same pattern for GitLab PAT, Codex import-token, iFlow cookie. Reauth deep-link UX is broken for these: user gets phone notif → clicks → lands on dashboard → still has to open Cursor IDE on the same machine.

**Add a separate UX branch for non-refresh-capable providers:**

1. **Notifier kind:** when `!connection.refreshToken && connection.authType !== "oauth"` (or provider in NON_REFRESH_PROVIDERS list), emit `kind: "manual_reimport_needed"` instead of `"reauth"`. Different message: `[MANUAL REIMPORT] <provider>/<name> needs token re-import — open <provider> CLI/IDE`.
2. **Deep-link target:** still `/dashboard/providers/<provider>?reconnect=<connId>` but the page detects non-refresh providers and shows the manual import instructions inline (Cursor → "Open Cursor IDE on this machine, then click Auto-import"; GitLab PAT → "Generate a new PAT and paste").
3. **Phase 5 fallback skip still applies** — `needsReauth=true` filters them out of combo selection regardless of `refreshToken`.

**Provider scope alignment:** plan.md's "All OAuth providers" list (12) is stale. Actual active OAuth providers from `src/shared/constants/providers.js:57-67`: `claude, antigravity, codex, github, cursor, xai, kilocode, cline` (8). Plan-listed `qwen, gitlab, qoder, iflow` are commented out; `kiro, gemini-cli` are FREE_PROVIDERS. Phase 8 parameterized test must iterate the LIVE registry (`Object.keys(OAUTH_PROVIDERS)`) — not a hardcoded 12-string list.

**Use a runtime check, not a provider list** — categorize at connection-level instead of provider-level. Reason: codex has BOTH OAuth refresh AND a manual `codex/import-token` route (verified at `src/app/api/oauth/codex/import-token/route.js`); the provider id remains `codex` in both cases. Also `gitlab`, `iflow`, `qoder`, `qwen` are currently commented out in OAUTH_PROVIDERS (`src/shared/constants/providers.js:8,10,12,13`) so they have no live OAuth surface anyway.

Helper in `src/lib/oauth/reauth-state.js`:
```js
export function supportsAutomatedReauth(connection) {
  return Boolean(connection?.refreshToken) && connection?.authType === "oauth";
}
```

Use in:
- **Phase 4**: when `!supportsAutomatedReauth(conn)`, emit `kind: "manual_reimport_needed"` instead of `"reauth"`.
- **Phase 6**: UI branch — if `!supportsAutomatedReauth`, show provider-specific reimport instructions instead of auto-OAuth trigger.
- **Phase 8**: e2e test parameterized on `Object.keys(OAUTH_PROVIDERS).filter(p => supportsAutomatedReauth(seedConnection(p)))` for the auto-OAuth path; manual-reimport path tested separately with seed `{ refreshToken: null }` connections.

Verified providers with `refreshToken: null` at insertion: `gitlab/pat` (`src/app/api/oauth/gitlab/pat/route.js:43`), `cursor/import` (`src/app/api/oauth/cursor/import/route.js:47`), GitHub device flow (`src/lib/oauth/services/github.js:170`). Anything else picks up via the same runtime check without needing a hardcoded list.
