---
phase: 8
title: "E2E smoke + docs / CHANGELOG"
status: pending
priority: P2
effort: "3-4h"
dependencies: [1, 2, 3, 4, 5, 6, 7]
---

# Phase 8: End-to-end smoke + docs

## Overview

Glue test that exercises the full Case-B flow as a single scenario, and document the feature in CHANGELOG, README, and `docs/`. No new production code beyond test fixtures and docs.

## Requirements

- Functional
  - One end-to-end test that runs the full path:
    1. Two OAuth connections for the same provider (`active=true`, healthy).
    2. Inject a stub `getAccessToken` that returns `{ error: "invalid_grant" }` for connection A.
    3. Fire a chat request → expects:
       - Connection A picked first (priority order) → refresh fails fatally.
       - `data.needsReauth === true` for A.
       - Exactly one Discord webhook captured by a mock receiver, payload contains `[REAUTH]` + deep-link to `/dashboard/providers/<provider>?reconnect=<A.id>`.
       - Combo fallback picks connection B → request succeeds (200).
       - Repeat the same request → no second webhook (dedup verified).
    4. Simulate user clicking the deep-link via direct call to `/api/oauth/<provider>/authorize?connectionId=<A.id>` and then the exchange callback with a fresh token → A's row is updated in place, `needsReauth=false`.
    5. Fire another chat request → A is selected again (back in rotation), request succeeds with new token.
  - Manual smoke checklist for UI (browser-driven) covering the deep-link URL navigation and the auto-trigger gesture.
- Non-functional
  - Test must run on the existing test runner without new external dependencies (uses a local mock HTTP receiver, not the real Discord API).
  - Test cleans up its DB state (use temp `DATA_DIR`).

## Architecture

```
tests/e2e/reauth-full-flow.test.js
   ├── setup: temp DATA_DIR, seed 2 OAuth connections (provider=test-oauth-provider)
   ├── mock: getAccessToken stubbed (per-connection behavior)
   ├── mock: HTTP listener captures POST to env.DISCORD_WEBHOOK_URL
   ├── run: 5-step scenario above
   └── teardown
```

## Related Code Files

- Create: `tests/e2e/reauth-full-flow.test.js`
- Create: `tests/e2e/__fixtures__/mock-webhook-receiver.js`
- Modify: `CHANGELOG.md` — entry under upcoming version
- Modify: `README.md` — update the "🔄 Auto Token Refresh" section to also describe re-auth notify behavior
- Modify (or create): `docs/system-architecture.md` — short section on OAuth auto re-login lifecycle (one paragraph + flow diagram identical to plan.md's "Architecture" block)
- Modify: `docs/project-changelog.md` (per `~/.claude/rules/documentation-management.md`)

## TDD — failing test first

Write the e2e test in its entirety following the scenario in Requirements before any docs edits. Confirm red (it depends on Phases 1–7 being done, which they are at this point). Iterate against bugs that only surface in the glue.

## Implementation Steps

1. Build the mock webhook receiver — minimal Node `http.createServer` capturing JSON POSTs, exposing `requests` array. Start before test, stop after.
2. Build the OAuth provider stub — register a fake provider id `test-oauth-provider` in the provider registry for the duration of the test (or mock at the module boundary if registry mutation is awkward).
3. Write the e2e test scenario. Confirm green.
4. Update `CHANGELOG.md`:
   ```
   ### Added
   - Provider auto re-auth: detect dead refresh tokens (Case B), mark connection
     `needsReauth=true`, send a single Discord/Telegram/Generic webhook with a
     1-click reconnect deep-link, and auto-skip the dead connection in combo
     fallback. Reuses existing warmup notifier ENV vars (DISCORD_WEBHOOK_URL,
     TELEGRAM_BOT_TOKEN, GENERIC_WEBHOOK_URL).
   - tts/stt handlers now run proactive token refresh (Case A fix).
   - Mid-stream 401/403 retry-once across image/embed/search/fetch/tts/stt.
   ### Changed
   - OAuth exchange/poll/import endpoints accept an optional `connectionId` to
     update the existing connection row instead of creating a new one.
   - UI shows a distinct "Needs Reauth" badge with a "Reconnect" primary button.
   ```
5. Update README "🔄 Auto Token Refresh" section to mention the new notify + deep-link behavior. Keep it terse.
6. Add a short section to `docs/system-architecture.md` describing the OAuth re-auth lifecycle with the same flow diagram as plan.md.
7. Run the full test suite — confirm zero regressions.

## Success Criteria

- [ ] E2E test passes end-to-end with no flake over 10 consecutive runs.
- [ ] Webhook receiver records exactly one POST per `(connectionId, reauthAt)` incident.
- [ ] After OAuth callback, follow-up request uses the same connection row id.
- [ ] CHANGELOG, README, docs updated.
- [ ] `npm run build` clean.

## Risk Assessment

| Risk | Mitigation |
| ---- | ---------- |
| Test flake on async fire-and-forget notify | Test awaits a small `waitFor()` on the mock receiver's `requests.length >= 1` before assertions. |
| Mock webhook receiver port collision in CI | Use `0` (random) port + read assigned port back. |
| Provider-registry mutation leaks across tests | Setup/teardown isolated; ensure `beforeAll`/`afterAll` cleanup. |
| Docs drift later when Phase 4 reasons enum expands | Single source of truth: list reasons in the helper file's JSDoc; docs link to the file. |

## Next Steps

Plan complete. After merge, monitor logs for `REAUTH_NOTIFY` warnings and adjust the classifier patterns if any provider's refresh error message isn't caught.

## Red Team Adjustments — 2026-05-24

Finding **F14** accepted. Plus downstream doc updates from F1/F9.

### F14 — Test runner is Vitest, NOT `node --test` (MEDIUM)

Repo verified: `tests/unit/oauth-cursor-auto-import.test.js:1` uses `import {describe, it, expect, vi, beforeEach, afterEach} from "vitest"`. `tests/package.json:8` declares vitest. Only the warmup suite uses `node --test` (`package.json:13` — `tests/warmup-*.test.mjs` root-level). All TDD instructions in plan.md ("Methodology" line 99) and every phase that says "Phase 1 wires `--experimental-vm-modules node --test`" are wrong.

**Corrections (apply to ALL phases):**

1. **Default test runner: Vitest.** Test file paths under `tests/oauth/`, `tests/sse/`, `tests/notifier/`, `tests/ui/` — follow existing pattern `tests/unit/*.test.js` style. Imports use `from "vitest"`.

2. **Vitest CLI:**
   ```bash
   NODE_PATH=/tmp/node_modules /tmp/node_modules/.bin/vitest run [file-pattern]
   ```
   Or whatever wrapper the repo uses — verify with `grep -n "vitest" package.json`.

3. **Mocking:** use `vi.mock(...)` and `vi.spyOn(...)` — NOT `mock.method(...)` or `t.mock.method(...)`.

4. **E2E test in this phase**: keep as Vitest with `describe`/`it`. The mock webhook receiver remains a `node:http` server — no test-framework dependency for that part.

5. **UI tests (Phase 6)**: react-testing-library is NOT installed (`grep "@testing-library" package.json` returns nothing). Either:
   - (a) downgrade Phase 6 to a pure-helper unit test for `getEffectiveStatus(conn)` + a manual-smoke checklist for the auto-trigger gesture, OR
   - (b) install `@testing-library/react`, `@testing-library/jest-dom`, `jsdom` (or `happy-dom`) — adds dependencies. Pick (a) per YAGNI.

### F1 — Phase 8 README/CHANGELOG must use correct env var names

CHANGELOG step 4 currently lists `DISCORD_WEBHOOK_URL, TELEGRAM_BOT_TOKEN, GENERIC_WEBHOOK_URL` — wrong. Replace with actual env vars:

```
- Reuses existing warmup notifier ENV vars (WARMUP_NOTIFY_ENABLED,
  WARMUP_NOTIFY_DISCORD_WEBHOOK, WARMUP_NOTIFY_TELEGRAM_BOT_TOKEN,
  WARMUP_NOTIFY_TELEGRAM_CHAT_ID, WARMUP_NOTIFY_GENERIC_WEBHOOK_URL).
  New: PUBLIC_BASE_URL for the reconnect deep-link host (falls back to
  path-only link if unset; cloud deployments should set this).
```

README "🔄 Auto Token Refresh" section must also list `PUBLIC_BASE_URL` requirement.

### F9 — Provider scope in docs must match live registry

E2E test must iterate `Object.keys(OAUTH_PROVIDERS)` (live source-of-truth at `src/shared/constants/providers.js:57-67`), not a hardcoded 12-string list. Document `NON_REFRESH_PROVIDERS` and the `manual_reimport_needed` UX track in `docs/system-architecture.md` reauth section.
