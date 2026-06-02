import assert from "node:assert/strict";
import test from "node:test";
import {
  __resetForTests,
  buildDigestPayload,
  buildDiscordPayload,
  buildGenericPayload,
  buildTelegramPayload,
  escapeMarkdownV2,
  isPrivateOrLoopbackIp,
  isValidDiscordWebhook,
  isValidHttpUrl,
  isValidPublicHttpUrl,
  isValidTelegramToken,
  logBootStatus,
  recordFailure,
  recordSuccess,
  redactSecrets,
  tryReserveFailureSlot,
  tryReserveRecoverySlot,
  tryReserveNotRegisteredSlot,
} from "../src/lib/warmup/notifier.js";

test("isValidDiscordWebhook accepts canonical discord webhook hosts", () => {
  assert.equal(
    isValidDiscordWebhook(
      "https://discord.com/api/webhooks/123456789012345678/" + "A".repeat(68),
    ),
    true,
  );
  assert.equal(
    isValidDiscordWebhook(
      "https://canary.discord.com/api/webhooks/123456789012345678/" + "B".repeat(68),
    ),
    true,
  );
  assert.equal(isValidDiscordWebhook("https://example.com/webhook"), false);
  assert.equal(
    isValidDiscordWebhook("http://discord.com/api/webhooks/123456789012345678/" + "C".repeat(68)),
    false,
  );
  assert.equal(isValidDiscordWebhook(""), false);
});

test("isValidTelegramToken matches Telegram BotFather format", () => {
  assert.equal(isValidTelegramToken("123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi"), true);
  assert.equal(isValidTelegramToken("123:short"), false);
  assert.equal(isValidTelegramToken("nope"), false);
  assert.equal(isValidTelegramToken(""), false);
});

test("isValidHttpUrl accepts http and https public targets, rejects loopback/private", () => {
  // red-team #1
  assert.equal(isValidHttpUrl("https://example.com/webhook"), true);
  assert.equal(isValidHttpUrl("http://example.com:9000/x"), true);
  assert.equal(isValidHttpUrl("http://127.0.0.1:9000/x"), false);
  assert.equal(isValidHttpUrl("ftp://example.com"), false);
  assert.equal(isValidHttpUrl("not-a-url"), false);
});

test("Discord payload includes schedule, connection, time, error and uses code fences", () => {
  __resetForTests({});
  const payload = buildDiscordPayload("failure", {
    schedule: { id: "s1", name: "Weekday warmup", timezone: "Asia/Ho_Chi_Minh" },
    connection: { id: "c1", name: "Claude-A", provider: "claude" },
    run: { localDate: "2026-05-19", localTime: "09:00", error: "401 unauthorized" },
  });
  assert.ok(payload.content.includes("Warmup failed"));
  assert.ok(payload.content.includes("Weekday warmup"));
  assert.ok(payload.content.includes("Claude-A"));
  assert.ok(payload.content.includes("2026-05-19 09:00"));
  assert.ok(payload.content.includes("401 unauthorized"));
});

test("Discord recovery payload mentions consecutive fails count", () => {
  __resetForTests({});
  const payload = buildDiscordPayload("recovery", {
    schedule: { id: "s1", name: "X", timezone: "UTC" },
    connection: { id: "c1", name: "A", provider: "claude" },
    run: { localDate: "2026-05-19", localTime: "10:00" },
    distinctFails: 4,
  });
  assert.ok(payload.content.includes("recovered"));
  assert.ok(payload.content.includes("4"));
});

test("Telegram payload uses parse_mode MarkdownV2 and chat_id", () => {
  __resetForTests({});
  const payload = buildTelegramPayload(
    "failure",
    {
      schedule: { id: "s1", name: "X", timezone: "UTC" },
      connection: { id: "c1", name: "A", provider: "claude" },
      run: { localDate: "2026-05-19", localTime: "10:00", error: "boom" },
    },
    "987654321",
  );
  assert.equal(payload.chat_id, "987654321");
  assert.equal(payload.parse_mode, "MarkdownV2");
  assert.ok(payload.text.includes("Warmup Failed"));
  assert.ok(payload.text.includes("boom"));
});

test("Generic payload includes event name and structured fields", () => {
  __resetForTests({});
  const payload = buildGenericPayload("failure", {
    schedule: { id: "s1", name: "X", timezone: "UTC" },
    connection: { id: "c1", name: "A", provider: "claude" },
    run: {
      localDate: "2026-05-19",
      localTime: "10:00",
      scheduledForUtc: "2026-05-19T03:00:00.000Z",
      error: "boom",
    },
  });
  assert.equal(payload.event, "warmup.failure");
  assert.equal(payload.schedule.id, "s1");
  assert.equal(payload.provider.connectionId, "c1");
  assert.equal(payload.run.localTime, "10:00");
  assert.equal(payload.error, "boom");
  assert.ok(payload.timestamp);
});

test("recovery state: success without prior failures does not emit", () => {
  __resetForTests({});
  const r = recordSuccess("conn-a");
  assert.equal(r.shouldEmitRecovery, false);
  assert.equal(r.distinctFails, 0);
});

test("recovery state: success below threshold resets counter, does not emit", () => {
  __resetForTests({ recoveryAfterFails: 3 });
  recordFailure("conn-a", "s1:c-a:2026-05-19:09:00");
  recordFailure("conn-a", "s1:c-a:2026-05-19:10:00");
  const r = recordSuccess("conn-a");
  assert.equal(r.shouldEmitRecovery, false);
  assert.equal(r.distinctFails, 2);
  const next = recordSuccess("conn-a");
  assert.equal(next.distinctFails, 0);
});

test("recovery state: success at or above threshold emits exactly once", () => {
  __resetForTests({ recoveryAfterFails: 3 });
  recordFailure("conn-a", "s1:c-a:2026-05-19:09:00");
  recordFailure("conn-a", "s1:c-a:2026-05-19:10:00");
  recordFailure("conn-a", "s1:c-a:2026-05-19:11:00");
  const r = recordSuccess("conn-a");
  assert.equal(r.shouldEmitRecovery, true);
  assert.equal(r.distinctFails, 3);
  const next = recordSuccess("conn-a");
  assert.equal(next.shouldEmitRecovery, false);
  assert.equal(next.distinctFails, 0);
});

test("failure rate limiter allows up to cap per sliding hour, drops after", () => {
  __resetForTests({ rateLimitPerHour: 3 });
  const t0 = Date.now();
  assert.equal(tryReserveFailureSlot(t0), true);
  assert.equal(tryReserveFailureSlot(t0 + 1), true);
  assert.equal(tryReserveFailureSlot(t0 + 2), true);
  assert.equal(tryReserveFailureSlot(t0 + 3), false);
  // 61 minutes later, window slides
  assert.equal(tryReserveFailureSlot(t0 + 61 * 60 * 1000), true);
});

test("failure rate limiter cap = 0 disables sending", () => {
  __resetForTests({ rateLimitPerHour: 0 });
  assert.equal(tryReserveFailureSlot(Date.now()), false);
});

// --- Red-team #1: SSRF deny-list ---

test("isValidPublicHttpUrl rejects loopback, RFC1918, link-local, IPv6 ULA", () => {
  assert.equal(isValidPublicHttpUrl("https://example.com/x"), true);
  assert.equal(isValidPublicHttpUrl("http://127.0.0.1:9000/x"), false);
  assert.equal(isValidPublicHttpUrl("http://localhost/x"), false);
  assert.equal(isValidPublicHttpUrl("http://10.0.0.1/x"), false);
  assert.equal(isValidPublicHttpUrl("http://192.168.1.1/x"), false);
  assert.equal(isValidPublicHttpUrl("http://172.16.0.1/x"), false);
  assert.equal(isValidPublicHttpUrl("http://169.254.169.254/latest/meta-data/"), false);
  assert.equal(isValidPublicHttpUrl("http://[::1]/x"), false);
  assert.equal(isValidPublicHttpUrl("http://[fc00::1]/x"), false);
});

test("isPrivateOrLoopbackIp covers the same ranges", () => {
  assert.equal(isPrivateOrLoopbackIp("127.0.0.1"), true);
  assert.equal(isPrivateOrLoopbackIp("10.5.6.7"), true);
  assert.equal(isPrivateOrLoopbackIp("172.16.0.1"), true);
  assert.equal(isPrivateOrLoopbackIp("192.168.0.1"), true);
  assert.equal(isPrivateOrLoopbackIp("169.254.169.254"), true);
  assert.equal(isPrivateOrLoopbackIp("::1"), true);
  assert.equal(isPrivateOrLoopbackIp("fc00::1"), true);
  assert.equal(isPrivateOrLoopbackIp("fe80::1"), true);
  assert.equal(isPrivateOrLoopbackIp("8.8.8.8"), false);
});

// --- Red-team #3: secret redaction ---

test("redactSecrets strips configured token and webhook URL substrings", () => {
  __resetForTests({
    telegramToken: "999999:LEAKABLE_TOKEN_VALUE_AAAAAAAAAAAAAAAAAA",
    discordUrl:
      "https://discord.com/api/webhooks/123456789012345678/SECRET_TOKEN_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    genericUrl: "https://hook.example.com/webhook/PRIVATE_SECRET",
  });
  const sample =
    "fetch failed for https://api.telegram.org/bot999999:LEAKABLE_TOKEN_VALUE_AAAAAAAAAAAAAAAAAA/sendMessage and https://discord.com/api/webhooks/123456789012345678/SECRET_TOKEN_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA and https://hook.example.com/webhook/PRIVATE_SECRET";
  const redacted = redactSecrets(sample);
  assert.equal(redacted.includes("LEAKABLE"), false);
  assert.equal(redacted.includes("SECRET_TOKEN_AAAA"), false);
  assert.equal(redacted.includes("PRIVATE_SECRET"), false);
});

test("redactSecrets catches generic bot{N}:{token} pattern even when not in config", () => {
  __resetForTests({});
  const sample = "Bearer bot999:UnknownButLooksLikeBotTokenAAAAAAAA";
  const redacted = redactSecrets(sample);
  assert.equal(redacted.includes("UnknownButLooksLikeBotToken"), false);
});

// --- Red-team #4: Discord allowed_mentions + truncate ---

test("Discord payload sets allowed_mentions parse=[] and truncates long error", () => {
  __resetForTests({});
  const longErr = "@everyone " + "x".repeat(5000);
  const payload = buildDiscordPayload("failure", {
    schedule: { id: "s1", name: "X", timezone: "UTC" },
    connection: { id: "c1", name: "A", provider: "claude" },
    run: { localDate: "2026-05-19", localTime: "10:00", error: longErr },
  });
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
  assert.ok(payload.content.length <= 2000);
  assert.ok(!payload.content.includes("@everyone"));
});

// --- Red-team #7: Telegram MarkdownV2 escape ---

test("Telegram payload uses MarkdownV2 and escapes special chars", () => {
  __resetForTests({});
  const payload = buildTelegramPayload(
    "failure",
    {
      schedule: { id: "s1", name: "Foo *bar* [baz]", timezone: "UTC" },
      connection: { id: "c1", name: "A_B", provider: "claude" },
      run: {
        localDate: "2026-05-19",
        localTime: "10:00",
        error: "prompt too long: 200_001 > 200_000",
      },
    },
    "987654321",
  );
  assert.equal(payload.parse_mode, "MarkdownV2");
  assert.equal(payload.text.includes("200\\_001"), true);
  assert.equal(payload.text.includes("Foo \\*bar\\* \\[baz\\]"), true);
});

test("escapeMarkdownV2 escapes every reserved char", () => {
  const out = escapeMarkdownV2("_*[]()~`>#+-=|{}.!\\");
  for (const c of "_*[]()~`>#+-=|{}.!\\") {
    assert.ok(out.includes("\\" + c), `missing escape for ${c}`);
  }
});

// --- Red-team #6: recovery counter dedupes by slot ---

test("recordFailure on same (connectionId, dedupeKey) does NOT inflate counter", () => {
  __resetForTests({ recoveryAfterFails: 3 });
  const r1 = recordFailure("conn-a", "s1:c-a:2026-05-19:09:00");
  const r2 = recordFailure("conn-a", "s1:c-a:2026-05-19:09:00");
  const r3 = recordFailure("conn-a", "s1:c-a:2026-05-19:09:00");
  assert.equal(r1.distinctFails, 1);
  assert.equal(r2.distinctFails, 1);
  assert.equal(r3.distinctFails, 1);
  const success = recordSuccess("conn-a");
  assert.equal(success.shouldEmitRecovery, false);
});

test("recordFailure on distinct slots accumulates to threshold", () => {
  __resetForTests({ recoveryAfterFails: 3 });
  recordFailure("conn-a", "s1:c-a:2026-05-19:09:00");
  recordFailure("conn-a", "s1:c-a:2026-05-19:10:00");
  recordFailure("conn-a", "s1:c-a:2026-05-19:11:00");
  const success = recordSuccess("conn-a");
  assert.equal(success.shouldEmitRecovery, true);
  assert.equal(success.distinctFails, 3);
});

// --- Red-team #15: separate recovery budget ---

test("recovery budget is independent from failure budget", () => {
  __resetForTests({ rateLimitPerHour: 1, recoveryRateLimitPerHour: 1 });
  const t0 = Date.now();
  assert.equal(tryReserveFailureSlot(t0), true);
  assert.equal(tryReserveFailureSlot(t0 + 1), false);
  assert.equal(tryReserveRecoverySlot(t0 + 2), true);
  assert.equal(tryReserveRecoverySlot(t0 + 3), false);
});

// --- Red-team #13: boot log surfaces state size ---

test("logBootStatus emits recoveryState.size and rateLimitWindow.length and recoveryWindow.length", () => {
  __resetForTests({});
  const lines = [];
  const origLog = console.log;
  console.log = (line) => lines.push(line);
  try {
    logBootStatus();
  } finally {
    console.log = origLog;
  }
  const parsed = JSON.parse(lines.at(-1));
  assert.equal(parsed.event, "boot");
  assert.equal(typeof parsed["recoveryState.size"], "number");
  assert.equal(typeof parsed["rateLimitWindow.length"], "number");
  assert.equal(typeof parsed["recoveryWindow.length"], "number");
});

// --- Red-team #2: digest payload ---

test("buildDigestPayload returns channel-aware summary with batch sample", () => {
  __resetForTests({});
  const batch = [
    {
      scheduleId: "s1",
      scheduleName: "Morning",
      connectionId: "c1",
      localDate: "2026-05-19",
      localTime: "09:00",
      error: "boom1",
    },
    {
      scheduleId: "s2",
      scheduleName: "Noon",
      connectionId: "c2",
      localDate: "2026-05-19",
      localTime: "12:00",
      error: "boom2",
    },
  ];
  const disc = buildDigestPayload("discord", batch);
  assert.ok(disc.content.includes("catch-up digest"));
  assert.ok(disc.content.includes("2"));
  assert.deepEqual(disc.allowed_mentions, { parse: [] });

  const tg = buildDigestPayload("telegram", batch);
  assert.equal(tg.parse_mode, "MarkdownV2");
  assert.ok(tg.text.includes("catch\\-up digest") || tg.text.includes("catch-up"));

  const generic = buildDigestPayload("generic", batch);
  assert.equal(generic.event, "warmup.digest");
  assert.equal(generic.batchSize, 2);
  assert.ok(Array.isArray(generic.sample));
});

// --- not_registered kind: distinct payloads via KIND_META ---

test("Discord not_registered payload mentions session not registering, includes resetsAt", () => {
  __resetForTests({});
  const payload = buildDiscordPayload("not_registered", {
    schedule: { id: "s1", name: "Morning", timezone: "UTC" },
    connection: { id: "c1", name: "Claude-A", provider: "claude" },
    run: { localDate: "2026-06-02", localTime: "09:00", sessionState: "not-registered", resetsAt: "2026-06-02T14:47:00.000Z" },
  });
  assert.ok(payload.content.toLowerCase().includes("did not register") || payload.content.toLowerCase().includes("not register"));
  assert.ok(payload.content.includes("Claude-A"));
  assert.ok(payload.content.includes("claude"));
  assert.ok(payload.content.includes("2026-06-02T14:47:00.000Z"));
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
  assert.ok(payload.content.length <= 2000);
  // distinct from failure wording
  assert.ok(!payload.content.includes("Warmup failed"));
});

test("Telegram not_registered payload is MarkdownV2 and distinct from failure", () => {
  __resetForTests({});
  const payload = buildTelegramPayload("not_registered", {
    schedule: { id: "s1", name: "Morning", timezone: "UTC" },
    connection: { id: "c1", name: "A", provider: "claude" },
    run: { localDate: "2026-06-02", localTime: "09:00", sessionState: "not-registered", resetsAt: "2026-06-02T14:47:00.000Z" },
  }, "987654321");
  assert.equal(payload.parse_mode, "MarkdownV2");
  assert.ok(!payload.text.includes("Warmup Failed"));
  assert.ok(payload.text.toLowerCase().includes("register"));
});

test("Generic not_registered payload emits warmup.not_registered event (proves map, not failure ternary)", () => {
  __resetForTests({});
  const payload = buildGenericPayload("not_registered", {
    schedule: { id: "s1", name: "X", timezone: "UTC" },
    connection: { id: "c1", name: "A", provider: "claude" },
    run: { localDate: "2026-06-02", localTime: "09:00", scheduledForUtc: "2026-06-02T02:00:00.000Z", sessionState: "not-registered", resetsAt: "2026-06-02T14:47:00.000Z" },
  });
  assert.equal(payload.event, "warmup.not_registered");
  assert.equal(payload.run.sessionState, "not-registered");
  assert.equal(payload.run.resetsAt, "2026-06-02T14:47:00.000Z");
});

test("name-field injection neutralized: backticks + @here in connection name", () => {
  __resetForTests({});
  const ctx = {
    schedule: { id: "s1", name: "X", timezone: "UTC" },
    connection: { id: "c1", name: "evil`@here`", provider: "claude" },
    run: { localDate: "2026-06-02", localTime: "09:00", sessionState: "not-registered", resetsAt: null },
  };
  const disc = buildDiscordPayload("not_registered", ctx);
  assert.ok(!disc.content.includes("@here"), "Discord must neutralize @here in name");
  const tg = buildTelegramPayload("not_registered", ctx, "1");
  // backticks in name escaped under MarkdownV2
  assert.ok(tg.text.includes("\\`"), "Telegram must escape backticks in name");
});

test("not_registered budget is independent from failure and recovery budgets (Finding 9)", () => {
  __resetForTests({ rateLimitPerHour: 1, recoveryRateLimitPerHour: 1, notRegisteredRateLimitPerHour: 1 });
  const t0 = Date.now();
  // Exhaust not-registered budget
  assert.equal(tryReserveNotRegisteredSlot(t0), true);
  assert.equal(tryReserveNotRegisteredSlot(t0 + 1), false);
  // Failure + recovery budgets untouched
  assert.equal(tryReserveFailureSlot(t0 + 2), true);
  assert.equal(tryReserveRecoverySlot(t0 + 3), true);
});

test("digest carries a labeled not-registered section distinct from failures", () => {
  __resetForTests({});
  const batch = [
    { scheduleId: "s1", scheduleName: "Morning", connectionId: "c1", localDate: "2026-06-02", localTime: "09:00", error: "boom" },
  ];
  const notReg = [
    { scheduleId: "s2", scheduleName: "Noon", connectionId: "c2", localDate: "2026-06-02", localTime: "12:00", resetsAt: "2026-06-02T17:00:00.000Z", sessionState: "not-registered" },
  ];
  const disc = buildDigestPayload("discord", batch, notReg);
  assert.ok(disc.content.includes("c2"), "not-registered connection present");
  assert.ok(disc.content.toLowerCase().includes("not register") || disc.content.toLowerCase().includes("not-registered"));
  assert.ok(disc.content.includes("boom"), "failure section still present");

  const generic = buildDigestPayload("generic", batch, notReg);
  assert.equal(generic.batchSize, 1);
  assert.ok(Array.isArray(generic.notRegistered));
  assert.equal(generic.notRegistered.length, 1);
});

// --- Logger emits JSON.parse-able line ---

test("logBootStatus output line is JSON.parse-able", () => {
  __resetForTests({});
  const lines = [];
  const origLog = console.log;
  console.log = (line) => lines.push(line);
  try {
    logBootStatus();
  } finally {
    console.log = origLog;
  }
  assert.doesNotThrow(() => JSON.parse(lines.at(-1)));
});
