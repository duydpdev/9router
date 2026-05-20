// Reauth alert — fans out the warmup notifier channels with a [REAUTH] prefix
// and a 1-click deep-link. Reuses warmup ENV vars + transport; bypasses the
// warmup rate limiter because `markReauthNotified` already dedupes per
// `(connectionId, reauthAt)` tuple.
import {
  markReauthNotified,
  rollbackReauthNotified,
} from "../oauth/reauth-state.js";
import {
  getNotifierConfig,
  getNotifierDispatcher,
  sendDiscord,
  sendTelegram,
  sendGeneric,
  sanitizeDiscordMentions,
  escapeMarkdownV2,
} from "../warmup/notifier.js";

const REAUTH_KIND = "reauth";
const MANUAL_REIMPORT_KIND = "manual_reimport_needed";

function resolveBaseUrl() {
  const base =
    process.env.PUBLIC_BASE_URL ||
    process.env.BASE_URL ||
    process.env.NEXT_PUBLIC_BASE_URL ||
    null;
  return base ? String(base).trim() || null : null;
}

function buildDeepLink(connection) {
  const base = resolveBaseUrl();
  const path = `/dashboard/providers/${connection.provider}?reconnect=${connection.id}`;
  return base ? `${base.replace(/\/+$/, "")}${path}` : path;
}

function buildReauthCtx({ connection, reason, reauthAt, kind }) {
  return {
    kind: kind ?? REAUTH_KIND,
    prefix: kind === MANUAL_REIMPORT_KIND ? "[MANUAL REIMPORT]" : "[REAUTH]",
    title:
      kind === MANUAL_REIMPORT_KIND
        ? `${connection.provider}/${connection.name ?? connection.id} needs token re-import`
        : `${connection.provider}/${connection.name ?? connection.id} needs reconnect`,
    fields: {
      provider: connection.provider,
      connectionId: connection.id,
      connectionName: connection.name,
      email: connection.email,
      reason,
      reauthAt,
    },
    deepLinkUrl: buildDeepLink(connection),
  };
}

export function buildReauthDiscordPayload(ctx) {
  const safeName = sanitizeDiscordMentions(
    ctx.fields.connectionName ?? ctx.fields.connectionId ?? "(connection)",
  );
  const safeProvider = sanitizeDiscordMentions(ctx.fields.provider ?? "(provider)");
  const content = `${ctx.prefix} **${safeProvider}/${safeName}** ${
    ctx.kind === MANUAL_REIMPORT_KIND ? "needs token re-import" : "needs reconnect"
  }`;
  return {
    content,
    embeds: [
      {
        title: ctx.title,
        url: ctx.deepLinkUrl,
        fields: [
          { name: "Reason", value: String(ctx.fields.reason ?? "unknown"), inline: true },
          { name: "Time", value: String(ctx.fields.reauthAt ?? ""), inline: true },
        ],
        color: ctx.kind === MANUAL_REIMPORT_KIND ? 0x0a84ff : 0xf0b400,
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

export function buildReauthTelegramText(ctx) {
  const safeName = escapeMarkdownV2(
    ctx.fields.connectionName ?? ctx.fields.connectionId ?? "(connection)",
  );
  const safeProvider = escapeMarkdownV2(ctx.fields.provider ?? "(provider)");
  const safeReason = escapeMarkdownV2(String(ctx.fields.reason ?? "unknown"));
  const safeWhen = escapeMarkdownV2(String(ctx.fields.reauthAt ?? ""));
  const safePrefix = escapeMarkdownV2(ctx.prefix);
  const linkLabel = ctx.kind === MANUAL_REIMPORT_KIND ? "Re\\-import" : "Reconnect";
  const verb = ctx.kind === MANUAL_REIMPORT_KIND ? "needs token re\\-import" : "needs reconnect";
  return (
    `${safePrefix} *${safeProvider}/${safeName}* ${verb}\n` +
    `Reason: ${safeReason}\n` +
    `At: ${safeWhen}\n` +
    `[${linkLabel}](${ctx.deepLinkUrl})`
  );
}

export function buildReauthGenericPayload(ctx) {
  return {
    event: ctx.kind === MANUAL_REIMPORT_KIND ? "provider.manual_reimport_needed" : "provider.reauth_required",
    kind: ctx.kind,
    title: ctx.title,
    fields: ctx.fields,
    deepLinkUrl: ctx.deepLinkUrl,
    timestamp: new Date().toISOString(),
  };
}

// Public API ──────────────────────────────────────────────────────────────────

export async function notifyReauthRequired({ connection, reason, reauthAt, kind } = {}) {
  if (!connection?.id || !reauthAt) {
    return { notified: false, error: "missing_connection_or_reauthAt" };
  }

  // CAS — claim the slot before fanout so concurrent failures dedupe.
  const claimed = await markReauthNotified(connection.id, { reauthAt });
  if (!claimed) return { notified: false, deduped: true };

  const cfg = getNotifierConfig();
  if (!cfg.enabled) return { notified: false, disabled: true };

  const ctx = buildReauthCtx({ connection, reason, reauthAt, kind });
  const dispatcher = getNotifierDispatcher();
  const tasks = [];
  if (cfg.discord.enabled) {
    tasks.push(
      sendDiscord(buildReauthDiscordPayload(ctx), cfg.discord.url, dispatcher).then((r) => ({
        channel: "discord",
        ...r,
      })),
    );
  }
  if (cfg.telegram.enabled) {
    tasks.push(
      sendTelegram(
        {
          chat_id: cfg.telegram.chatId,
          parse_mode: "MarkdownV2",
          text: buildReauthTelegramText(ctx),
        },
        cfg.telegram.token,
        cfg.telegram.chatId,
        dispatcher,
      ).then((r) => ({ channel: "telegram", ...r })),
    );
  }
  if (cfg.generic.enabled) {
    tasks.push(
      sendGeneric(buildReauthGenericPayload(ctx), cfg.generic.url, dispatcher).then((r) => ({
        channel: "generic",
        ...r,
      })),
    );
  }

  if (!tasks.length) {
    // No channels configured — release the slot so the next attempt can fire
    // once a webhook gets configured.
    await rollbackReauthNotified(connection.id, { reauthAt });
    return { notified: false, channels: 0, rolledBack: true };
  }

  const results = await Promise.allSettled(tasks);
  const channels = results.map((r) =>
    r.status === "fulfilled" ? r.value : { ok: false, reason: String(r.reason?.message ?? r.reason) },
  );
  const delivered = channels.filter((c) => c.ok).length;

  if (delivered === 0) {
    await rollbackReauthNotified(connection.id, { reauthAt });
    return { notified: false, channels: channels.length, delivered: 0, rolledBack: true };
  }

  return { notified: true, channels: channels.length, delivered };
}
