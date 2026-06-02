import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyWarmupSession,
  normalizeUtil,
  normalizeResetAt,
} from "../src/lib/warmup/session-state.js";

const future = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();
const past = () => new Date(Date.now() - 60 * 60 * 1000).toISOString();

test("non-session provider → n/a", () => {
  const r = classifyWarmupSession({ provider: "gemini", quota: { resetAt: future(), used: 10 }, usageOk: true, authoritative: true });
  assert.deepEqual(r, { sessionState: "n/a", resetsAt: null, utilization: null });
});

test("usageOk:false → unknown", () => {
  const r = classifyWarmupSession({ provider: "claude", quota: null, usageOk: false, authoritative: true });
  assert.equal(r.sessionState, "unknown");
  assert.equal(r.resetsAt, null);
});

test("valid future reset → active, utilization passed through", () => {
  const reset = future();
  const r = classifyWarmupSession({ provider: "claude", quota: { resetAt: reset, used: 87 }, usageOk: true, authoritative: true });
  assert.equal(r.sessionState, "active");
  assert.equal(r.resetsAt, reset);
  assert.equal(r.utilization, 87);
});

test("used === 0 with valid future reset → active (0% fresh window survives)", () => {
  const reset = future();
  const r = classifyWarmupSession({ provider: "claude", quota: { resetAt: reset, used: 0 }, usageOk: true, authoritative: true });
  assert.equal(r.sessionState, "active");
  assert.equal(r.utilization, 0);
});

test("resetAt null + authoritative → not-registered", () => {
  const r = classifyWarmupSession({ provider: "claude", quota: { resetAt: null, used: 5 }, usageOk: true, authoritative: true });
  assert.equal(r.sessionState, "not-registered");
  assert.equal(r.resetsAt, null);
});

test("resetAt null + non-authoritative → unknown (legacy fallback, no false alarm)", () => {
  const r = classifyWarmupSession({ provider: "claude", quota: { resetAt: null, used: 5 }, usageOk: true, authoritative: false });
  assert.equal(r.sessionState, "unknown");
});

test("resetAt in the past → not-registered when authoritative, unknown otherwise", () => {
  const p = past();
  assert.equal(classifyWarmupSession({ provider: "claude", quota: { resetAt: p, used: 5 }, usageOk: true, authoritative: true }).sessionState, "not-registered");
  assert.equal(classifyWarmupSession({ provider: "claude", quota: { resetAt: p, used: 5 }, usageOk: true, authoritative: false }).sessionState, "unknown");
});

test("codex behaves identically to claude", () => {
  const reset = future();
  const r = classifyWarmupSession({ provider: "codex", quota: { resetAt: reset, used: 33 }, usageOk: true, authoritative: true });
  assert.equal(r.sessionState, "active");
  assert.equal(r.utilization, 33);
});

test("normalizeUtil clamping", () => {
  assert.equal(normalizeUtil(-5), null);
  assert.equal(normalizeUtil(120), 100);
  assert.equal(normalizeUtil("42"), 42);
  assert.equal(normalizeUtil(NaN), null);
  assert.equal(normalizeUtil(0), 0);
  assert.equal(normalizeUtil(undefined), null);
});

test("normalizeResetAt: ISO passes, garbage → null", () => {
  const iso = "2026-06-02T14:47:00.000Z";
  assert.equal(normalizeResetAt(iso), iso);
  assert.equal(normalizeResetAt("not-a-date"), null);
  assert.equal(normalizeResetAt(null), null);
  assert.equal(normalizeResetAt(undefined), null);
});
