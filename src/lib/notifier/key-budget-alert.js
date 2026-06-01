// Per-key daily budget alert — fans out the warmup notifier channels with a
// [KEY BUDGET] prefix when a single API key crosses its daily token/request
// budget. Alert-only: this NEVER blocks or disables the key. Reuses the warmup
// ENV vars + transport (so it shares the WARMUP_NOTIFY_ENABLED gate), but has
// its OWN hourly flood cap so a fleet of leaked keys cannot exhaust the warmup
// rate-limit budget.
//
// SECURITY: the raw API key is never placed in any payload. Channel payloads
// are built from an explicit field allowlist (key NAME + masked keyHash only) —
// never a wholesale object spread.
import {
  getNotifierConfig,
  getNotifierDispatcher,
  sendDiscord,
  sendTelegram,
  sendGeneric,
  sanitizeDiscordMentions,
  escapeMarkdownV2,
} from "../warmup/notifier.js";
import { getApiKeys } from "../db/repos/apiKeysRepo.js";

// Dedicated hourly cap, independent of the warmup notifier's own window. Keeps
// budget alerts from flooding when many keys go over at once.
const BUDGET_ALERT_CAP_PER_HOUR = 20;
const budgetWindow = [];

// Mirror of notifier.tryReserveFailureSlot but on a private window so the two
// alert families never share a budget. `nowMs` injectable for tests.
export function tryReserveBudgetSlot(nowMs = Date.now(), cap = BUDGET_ALERT_CAP_PER_HOUR) {
  if (cap <= 0) return false;
  const cutoff = nowMs - 60 * 60 * 1000;
  while (budgetWindow.length && budgetWindow[0] < cutoff) budgetWindow.shift();
  if (budgetWindow.length >= cap) return false;
  budgetWindow.push(nowMs);
  return true;
}

// Resolve the human-readable key name from the raw key WITHOUT echoing the key.
// Returns a label only; the raw key never leaves this function.
async function resolveKeyName(apiKey) {
  try {
    const keys = await getApiKeys();
    const match = keys.find((k) => k.key === apiKey);
    return match?.name || "(unnamed key)";
  } catch {
    return "(unknown key)";
  }
}

function tierLabel(tier) {
  return tier === "over" ? "OVER BUDGET" : "approaching budget";
}

export function buildBudgetDiscordPayload(ctx) {
  const safeName = sanitizeDiscordMentions(ctx.keyName);
  const content = `[KEY BUDGET] **${safeName}** \`${ctx.keyHash}\` ${tierLabel(ctx.tier)} (${Math.round(ctx.pct)}%)`;
  return {
    content,
    embeds: [
      {
        title: `API key ${tierLabel(ctx.tier)}`,
        fields: [
          { name: "Key", value: `${safeName} (${ctx.keyHash})`, inline: false },
          { name: "Tier", value: `${ctx.tier} (${Math.round(ctx.pct)}%)`, inline: true },
          { name: "Tokens today", value: `${ctx.usage.tokens} / ${ctx.budget.tokenPerDay}`, inline: true },
          { name: "Requests today", value: `${ctx.usage.requests} / ${ctx.budget.requestPerDay}`, inline: true },
        ],
        color: ctx.tier === "over" ? 0xe01e1e : 0xf0b400,
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

export function buildBudgetTelegramText(ctx) {
  const safeName = escapeMarkdownV2(ctx.keyName);
  const safeHash = escapeMarkdownV2(ctx.keyHash);
  const safeTier = escapeMarkdownV2(`${ctx.tier} (${Math.round(ctx.pct)}%)`);
  const safeTok = escapeMarkdownV2(`${ctx.usage.tokens} / ${ctx.budget.tokenPerDay}`);
  const safeReq = escapeMarkdownV2(`${ctx.usage.requests} / ${ctx.budget.requestPerDay}`);
  return (
    `${escapeMarkdownV2("[KEY BUDGET]")} *${safeName}* \`${safeHash}\` ${escapeMarkdownV2(tierLabel(ctx.tier))}\n` +
    `Tier: ${safeTier}\n` +
    `Tokens: ${safeTok}\n` +
    `Requests: ${safeReq}`
  );
}

export function buildBudgetGenericPayload(ctx) {
  // Explicit allowlist — NO raw key, NO wholesale spread.
  return {
    event: "security.key_budget",
    tier: ctx.tier,
    pct: Math.round(ctx.pct),
    keyName: ctx.keyName,
    keyHash: ctx.keyHash,
    usage: { tokens: ctx.usage.tokens, requests: ctx.usage.requests },
    budget: { tokenPerDay: ctx.budget.tokenPerDay, requestPerDay: ctx.budget.requestPerDay },
    timestamp: new Date().toISOString(),
  };
}

// Send a per-key budget alert across all configured channels. Gated by the
// notifier enabled flag and the dedicated hourly flood cap. `nowMs` injectable
// for tests. Returns a small result object (never throws).
export async function notifyKeyBudget({ apiKey, keyHash, tier, pct, usage, budget }, nowMs = Date.now()) {
  try {
    const cfg = getNotifierConfig();
    if (!cfg.enabled) return { notified: false, disabled: true };
    if (!tryReserveBudgetSlot(nowMs)) return { notified: false, rateLimited: true };

    const keyName = await resolveKeyName(apiKey);
    const ctx = { keyName, keyHash, tier, pct, usage, budget };
    const dispatcher = getNotifierDispatcher();
    const tasks = [];
    if (cfg.discord.enabled) {
      tasks.push(
        sendDiscord(buildBudgetDiscordPayload(ctx), cfg.discord.url, dispatcher).then((r) => ({ channel: "discord", ...r })),
      );
    }
    if (cfg.telegram.enabled) {
      tasks.push(
        sendTelegram(
          { chat_id: cfg.telegram.chatId, parse_mode: "MarkdownV2", text: buildBudgetTelegramText(ctx) },
          cfg.telegram.token,
          cfg.telegram.chatId,
          dispatcher,
        ).then((r) => ({ channel: "telegram", ...r })),
      );
    }
    if (cfg.generic.enabled) {
      tasks.push(
        sendGeneric(buildBudgetGenericPayload(ctx), cfg.generic.url, dispatcher).then((r) => ({ channel: "generic", ...r })),
      );
    }

    if (!tasks.length) return { notified: false, channels: 0 };
    const results = await Promise.allSettled(tasks);
    const delivered = results.filter((r) => r.status === "fulfilled" && r.value.ok).length;
    return { notified: delivered > 0, channels: tasks.length, delivered };
  } catch (error) {
    return { notified: false, error: String(error?.message || error) };
  }
}

// Test hook — reset the flood-cap window between cases.
export const __test__ = {
  resetWindow: () => {
    budgetWindow.length = 0;
  },
  CAP_PER_HOUR: BUDGET_ALERT_CAP_PER_HOUR,
};
