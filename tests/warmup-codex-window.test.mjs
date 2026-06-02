import assert from "node:assert/strict";
import test from "node:test";
import { formatCodexWindow } from "../open-sse/services/usage.js";

// G1: a Codex window that exposes only a relative duration (resets_in_seconds)
// and no absolute reset must still yield a usable resetAt — otherwise every
// Codex warmup would falsely classify not-registered.
test("derives resetAt from resets_in_seconds when no absolute reset present", () => {
  const before = Date.now();
  const w = formatCodexWindow({ used_percent: 20, resets_in_seconds: 3600 });
  const after = Date.now();
  assert.ok(w.resetAt, "resetAt populated from duration");
  const ms = Date.parse(w.resetAt);
  assert.ok(ms >= before + 3600 * 1000 - 50 && ms <= after + 3600 * 1000 + 50, "resetAt ≈ now + 1h");
  assert.equal(w.used, 20);
});

test("prefers an absolute reset timestamp when present", () => {
  const abs = "2026-06-02T14:47:00.000Z";
  const w = formatCodexWindow({ used_percent: 50, reset_at: abs, resets_in_seconds: 999 });
  assert.equal(w.resetAt, abs);
});

test("no reset info at all → resetAt null", () => {
  const w = formatCodexWindow({ used_percent: 10 });
  assert.equal(w.resetAt, null);
});
