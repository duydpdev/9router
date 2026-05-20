// Reauth state helpers — read/write the four `data`-blob fields used to mark
// a connection as needing user re-login (Case B).
//
// Field semantics:
//   needsReauth        boolean  — combo fallback skips the row when true
//   reauthReason       enum     — invalid_grant | refresh_family_revoked | refresh_http_error | refresh_unknown
//   reauthAt           ISO ts   — when refresh first failed fatally for this incident
//   reauthNotifiedAt   ISO ts   — claimed-slot timestamp; CAS dedupes webhooks
//   lastErrorType      string   — surfaced by UI badges; cleared on reconnect
import {
  updateProviderConnection,
  compareAndUpdateProviderConnection,
} from "../db/repos/connectionsRepo.js";

export const REAUTH_REASONS = Object.freeze({
  INVALID_GRANT: "invalid_grant",
  REFRESH_FAMILY_REVOKED: "refresh_family_revoked",
  REFRESH_HTTP_ERROR: "refresh_http_error",
  REFRESH_UNKNOWN: "refresh_unknown",
});

export async function markNeedsReauth(connectionId, { reason, reauthAt, currentLastErrorType } = {}) {
  if (!connectionId) return false;
  const at = reauthAt ?? new Date().toISOString();
  const updates = {
    needsReauth: true,
    reauthReason: reason ?? REAUTH_REASONS.REFRESH_UNKNOWN,
    reauthAt: at,
    lastErrorAt: at,
  };
  // Preserve a more specific upstream error type if `markAccountUnavailable`
  // already wrote one — only overwrite when there's nothing meaningful there.
  if (!currentLastErrorType || currentLastErrorType === "token_refresh_failed") {
    updates.lastErrorType = "token_refresh_failed";
  }
  return !!(await updateProviderConnection(connectionId, updates));
}

export async function clearNeedsReauth(connectionId) {
  if (!connectionId) return false;
  return !!(await updateProviderConnection(connectionId, {
    needsReauth: false,
    reauthReason: null,
    reauthAt: null,
    reauthNotifiedAt: null,
    lastErrorType: null,
    lastErrorAt: null,
    lastError: null,
    errorCode: null,
  }));
}

// Atomic CAS — only writes `reauthNotifiedAt` when (a) the row still matches
// the caller's `reauthAt` and (b) no other writer has claimed the slot.
// Returns true exactly once per (connectionId, reauthAt) tuple under
// concurrent callers — backed by the connection-row transaction in the repo.
export async function markReauthNotified(connectionId, { reauthAt }) {
  if (!connectionId || !reauthAt) return false;
  const result = await compareAndUpdateProviderConnection(
    connectionId,
    (row) => row.reauthAt === reauthAt && !row.reauthNotifiedAt,
    { reauthNotifiedAt: new Date().toISOString() },
  );
  return !!result;
}

// Rollback a previously claimed slot. Used by the notifier when every fanout
// channel rejected — restoring `reauthNotifiedAt=null` lets the next failed
// request re-fire instead of staying silently deduped.
export async function rollbackReauthNotified(connectionId, { reauthAt }) {
  if (!connectionId || !reauthAt) return false;
  const result = await compareAndUpdateProviderConnection(
    connectionId,
    (row) => row.reauthAt === reauthAt && row.reauthNotifiedAt != null,
    { reauthNotifiedAt: null },
  );
  return !!result;
}

export function isNeedingReauth(connection) {
  return !!(connection && connection.needsReauth);
}

// Runtime classifier — providers without a refresh token (Cursor import,
// GitLab PAT, GitHub device-flow, etc.) cannot be reauthorized by OAuth and
// instead get the `manual_reimport_needed` UX track.
export function supportsAutomatedReauth(connection) {
  return Boolean(connection?.refreshToken) && connection?.authType === "oauth";
}
