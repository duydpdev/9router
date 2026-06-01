# Brainstorm — Bot Protection v2 Improvements (anti-scrape + anti-mining)

Date: 2026-06-01
Follows: `plans/260601-0800-bot-protection-layered/plan.md` (v1 floor, shipped)
Approach chosen: **A — App-floor đủ dùng** · Anomaly action: **alert-only** · Budget unit: **token OR request/day**

## Problem statement

v1 floor diệt tốt scanner đơn lẻ + flood 1-IP. Hai threat còn hở, user muốn improve:

1. **Scrape web/dashboard** — bot cào nội dung trang/dashboard (keyless web routes).
2. **"Đào" = mining free quota** — key leak hoặc keyless lạm dụng `/v1` rút free token (Kiro/OpenCode/Vertex), drain quota provider.

Deploy target: **VPS sau nginx (internet-exposed)**.

## Gaps in v1 (verified in code)

- Rule toàn **static blocklist** (`botRules.js`) — repo public → attacker đọc source biết UA/path nào bị chặn, né dễ.
- `/v1` valid key = 1200 req/min, **không có daily budget** → leaked key "đào" tự do tới khi revoke tay.
- Per-IP rate limit **vô dụng với botnet** (mỗi bot 1 IP) — nhưng botnet defense thuộc edge, không app.
- Không phát hiện **spike bất thường** per-key.

## Why NOT build all 4 levers (brutal honesty)

| Lever user muốn | Layer đúng | Verdict |
|---|---|---|
| Per-key budget + anomaly | App floor | **BUILD** (alert-only) — plumbing có sẵn |
| Challenge (Turnstile/PoW/honeypot) | Edge, chỉ keyless web | **PARTIAL** — Turnstile dashboard login; KHÔNG đụng `/v1` (vỡ SDK) |
| Persistent ban + repeat-offender | fail2ban đã làm trên VPS | **SKIP** — trùng fail2ban (XFF-safe ban off nginx log) |
| Geo/ASN + behavior scoring | ASN ở nginx GeoIP; behavior = ML | **PARTIAL** — ASN datacenter deny ở edge (rẻ); behavior scoring = YAGNI, false-positive cao, defer |

PoW + behavior ML loại bỏ: effort cao, maintain nặng, repo public lộ heuristic, phần lớn trùng fail2ban.

## Feasibility (reuse — verified)

- `usageHistory` table đã ghi mỗi request: `apiKey`, `tokens`, `cost`, `timestamp`, `status`, `provider`, `model` (`usageRepo.js:104`). Daily per-key aggregation `byApiKey` có sẵn (`usageRepo.js:58-72`). → **đọc budget không cần schema mới**.
- Warmup notifier (Discord/Telegram/Generic webhook) đã có → reuse cho alert. Env `WARMUP_NOTIFY_*` đã document.
- `apiKeys.isActive` + `updateApiKey()` tồn tại (không dùng cho alert-only, nhưng sẵn nếu sau muốn nâng lên auto-disable).

## Recommended design — Approach A

### Layer 1 (NEW, app): Per-key budget monitor + alert

- Module mới: `src/lib/security/keyBudget.js`.
- Trigger: trong `botGuard` → `rateLimitLlm`, sau khi key validated (`keyValid && apiKey`).
- Đọc usage hôm nay của key đó: `SELECT sum(tokens), count(*) FROM usageHistory WHERE apiKey=? AND timestamp >= <startOfLocalDay>`. Cache ~30-60s/key (giống `getCachedBotSettings`) — tránh sqlite hit mỗi request.
- Settings mới: `botProtection.keyBudget = { enabled, tokenPerDay, requestPerDay, warnAtPercent }`.
- Vượt token/ngày **OR** request/ngày → bắn **1 alert/key/ngày** (dedupe in-memory Map, reset on restart OK) qua warmup notifier. Alert sớm tại `warnAtPercent` (vd 80%) + 100%.
- **KHÔNG block, KHÔNG disable** (alert-only — user quyết). Enforcement path `/v1` không đổi → zero risk vỡ SDK.
- Defaults đề xuất (tunable): `tokenPerDay: 5_000_000`, `requestPerDay: 5000`, `warnAtPercent: 80`. Toggle trong Dashboard → Endpoint → Bot Protection.

**Tradeoff (document rõ):** alert-only → leaked key vẫn đào tới khi người react. Bù = alert sớm 80%. Nếu sau cần mạnh hơn → flip sang auto `isActive=0` (plumbing đã có).

### Layer 2 (edge, docs + nginx config): web-scrape defense

- **Turnstile/Cloudflare** chỉ trên dashboard login + keyless web routes (KHÔNG `/v1`). Thêm doc + nginx example.
- **GeoIP2 / ASN deny** datacenter ranges trên non-`/v1` web routes (scraper chạy datacenter). nginx `geoip2` map example trong `deploy/nginx/`.
- Đây là **docs/templates**, không phải app code.

### Layer 3 (edge, sharpen existing): fail2ban

- Thêm jail bắt **probe-403 flood** từ `bot-blocked.log` (đã có format JSON). Repeat-offender → ban dài hơn. Chỉ tweak `deploy/fail2ban/`.

## Out of scope (giữ nguyên v1 + thêm)

captcha trên `/v1`, PoW, behavior/ML scoring, persistent ban app-layer (fail2ban cover), Redis/shared store, auto-disable key (alert-only theo quyết định).

## Success metrics

- Leaked-key mining: alert tới Discord/Telegram trong ≤60s sau khi key vượt 80% budget.
- Web scrape: keyless datacenter-ASN request bị nginx deny trước khi tới app.
- Zero false-lockout key thật (alert-only đảm bảo).
- `/v1` SDK latency không tăng đáng kể (budget read cached).

## Risks

- Budget read sai nếu `usageHistory` timezone/startOfDay lệch — dùng `getLocalDateKey` (`usageRepo.js:30`) cho nhất quán.
- Alert spam nếu dedupe lỗi — Map key = `${keyHash}:${dateKey}:${tier}`.
- Turnstile thêm Cloudflare dependency — chỉ bật khi user muốn, không phá floor offline.

## Unresolved questions

1. Budget defaults (5M token / 5000 req/ngày) — user xác nhận hay tune theo traffic thật?
2. Alert ngưỡng: chỉ 100%, hay 80% + 100%? (đề xuất cả hai)
3. Layer 2 Turnstile — có cần ngay phase này, hay tách doc-only follow-up?
