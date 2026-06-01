---
phase: 5
title: "Crawler Control"
status: pending
priority: P2
effort: "1.5h"
dependencies: [3]
---

# Phase 5: Crawler Control

## Overview

Polite crawler layer complementing the hard UA block: serve `robots.txt` (disallow dashboard, allow landing) and add `noindex` to dashboard pages so well-behaved crawlers self-exclude. Settings UI toggles for the `botProtection` flags.

## Requirements
- Functional: `GET /robots.txt` → disallow `/dashboard`, `/api`, `/login`; allow `/`, `/landing`.
- Functional: dashboard routes emit `<meta name="robots" content="noindex,nofollow">` (or `robots` in metadata export).
- Functional: settings UI exposes `botProtection` toggles (enabled, blockProbePaths, blockBadUA, blockAiCrawlers, rate limits) wired to existing settings save flow.
- Non-functional: robots route static/cheap; UI matches existing dashboard settings patterns.

## Architecture

- `src/app/robots.js` — Next.js metadata route returning rules object. (Confirm App Router `robots.js` convention vs static file.)
- Dashboard `noindex`: add `robots: { index:false, follow:false }` to `metadata` export in `src/app/(dashboard)/layout.js` (or root layout for dashboard segment).
- Settings UI: locate existing settings page client (under `src/app/(dashboard)/dashboard/` — likely a settings/profile section) and existing settings API route; add a "Bot Protection" section with toggles, reuse existing form components + save handler. **Scout existing settings UI pattern first — mirror it, don't invent.**

## Related Code Files
- Create: `src/app/robots.js`
- Modify: `src/app/(dashboard)/layout.js` (noindex metadata)
- Modify: existing settings client + settings API route (add botProtection fields) — paths TBD by scout
- Create: `tests/security/robots.test.js`
- Read for context: `src/app/manifest.js` (metadata route pattern), existing settings page + `/api/settings` route

## Implementation Steps (TDD)
1. **Write test first** `tests/security/robots.test.js`: robots output disallows `/dashboard`,`/api`; allows `/`.
2. Implement `src/app/robots.js`.
3. Add `noindex` metadata to dashboard layout.
4. Scout existing settings UI + `/api/settings` write path; add botProtection toggle section mirroring existing controls.
5. Manual check: toggles persist + reflected in `getSettings()`.
6. Run → green.

## Success Criteria
- [ ] `/robots.txt` serves correct rules (test-proven)
- [ ] Dashboard pages carry `noindex`
- [ ] Settings UI toggles persist and drive runtime behavior (verified end-to-end with Phase 4)
- [ ] No new UI pattern invented — reuses existing settings components

## Risk Assessment
- **robots.js vs static robots.txt** in standalone output → verify App Router metadata route emits at `/robots.txt` in standalone build; fallback to `public/robots.txt` if not.
- **Settings UI scope creep** → keep to toggles + numeric inputs for limits; no fancy widgets.
- **robots.txt is advisory** → hard enforcement is Phase 1/4 UA block; robots is the polite layer only (documented).
