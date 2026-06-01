---
phase: 4
title: "Edge Hardening"
status: completed
priority: P2
effort: "3h"
dependencies: []
---

# Phase 4: Edge Hardening

## Overview

Web-scrape defense at the edge (VPS-nginx): Turnstile on dashboard login, datacenter-ASN deny on non-`/v1` web routes, fail2ban probe-flood jail. Docs + templates only — no app code. Independent of phases 1-3.

## Requirements

- Functional: copy-paste nginx + fail2ban templates + doc guidance to (a) gate dashboard login behind Cloudflare Turnstile, (b) deny known datacenter ASNs on web routes, (c) ban repeat probe floods.
- Non-functional (HARD, red-team Finding 14): `/v1` SDK traffic MUST stay unchallenged and un-denied — even when it originates from a datacenter (CI/serverless/VPS clients). Templates validate with `nginx -t`, `fail2ban-regex`, and a curl smoke test.

## Architecture

**`/v1` exclusion first (Finding 14)** — ship a high-precedence `location ^~ /v1 { ... }` block that proxies straight through with NO Turnstile, NO ASN deny, commented as the SDK carve-out. Turnstile/ASN logic lives only in web/dashboard `location` blocks evaluated after it. Prevents the common misconfig where a `server`-scope `deny` 444s all cloud-sourced SDK calls.

**Turnstile (dashboard login only)** — `location = /login` (+ login POST) validates a Cloudflare Turnstile token, or fronts with Cloudflare. Keyless web → challenge; valid session/API-key → pass. Explicit doc note: `/v1` and API-key auth are never challenged.

**Datacenter-ASN deny** — nginx `geoip2` maps `$asn` from MaxMind ASN DB; a `map` flags cloud/datacenter ASNs (AWS/GCP/Azure/OVH/Hetzner/DO…) → `deny`/`444` **inside web `location` blocks only**. Opt-in (requires MaxMind DB + module). Doc an allowlist note for legit datacenter/VPN users.

**fail2ban probe-flood jail (red-team Finding 15)** — jail tailing `bot-blocked.log` (JSON, `kind:"probe"`). **Disabled by default** in the template with a loud comment. Primary recommended path = ban off the **nginx access log** (real socket IP) like the existing `9router.jail`. The app-log jail is safe ONLY with `trustProxy=true` behind a trusted proxy — because `getTrustedClientIp` returns the forgeable XFF value regardless of the flag (`clientIp.js:19-22`), so on a direct-exposed deploy the logged IP is attacker-controlled and banning off it DoSes spoofed victims. Reuse v1 anchored failregex.

## Related Code Files

- Modify: `deploy/nginx/9router.conf.example` (`location ^~ /v1` carve-out + Turnstile login block + geoip2 ASN map + web-only deny)
- Create: `deploy/fail2ban/9router-probe.filter` + a **commented-out** jail stanza (or extend `9router.jail`)
- Modify: `docs/bot-protection.md` (new "Edge hardening (web scrape)" section; cross-link v1 XFF/`trustProxy` note)

## Implementation Steps

1. Add `location ^~ /v1` pass-through carve-out FIRST in the nginx example, commented as the SDK invariant.
2. Add Turnstile login block scoped to dashboard/login only.
3. Add `geoip2 $asn` map + datacenter deny inside web `location` blocks only; document MaxMind install + opt-in + allowlist.
4. Add probe-flood fail2ban filter + **disabled-by-default** jail; document the `trustProxy` gate and the nginx-access-log primary path.
5. Document everything in `docs/bot-protection.md`.

## Success Criteria

- [ ] `nginx -t` passes (placeholder MaxMind paths noted)
- [ ] **Smoke test:** a simulated datacenter-sourced `/v1` request passes; a `/dashboard` request from the same source is denied (curl with crafted ASN/test config)
- [ ] `fail2ban-regex bot-blocked.log deploy/fail2ban/9router-probe.filter` matches probe lines, ignores non-probe
- [ ] Probe jail stanza is commented-out by default; docs state it requires `trustProxy=true` and recommends the nginx-access-log jail as primary
- [ ] Docs state explicitly: Turnstile/ASN deny never apply to `/v1`
- [ ] No app code changed

## Risk Assessment

- Risk: ASN deny / server-scope misplacement breaks `/v1` SDKs from datacenters. Mitigation: `location ^~ /v1` carve-out + curl smoke test (Finding 14).
- Risk: probe jail bans spoofed-XFF victim. Mitigation: disabled-by-default, `trustProxy` gate, nginx-access-log primary (Finding 15).
- Risk: ASN deny false-positives on legit datacenter/VPN users. Mitigation: opt-in, web-routes-only, allowlist guidance.

## Out of Scope

PoW challenge, behavior/ML scoring, app-layer persistent ban, Redis shared store, auto-disable of keys.
