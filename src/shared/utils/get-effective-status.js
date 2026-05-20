// Centralized status helper used by the providers list + detail UIs.
// Precedence: needs_reauth > expired > unavailable > error > active.
//
// Reads only `connection`-level fields the API returns:
//   needsReauth, reauthReason, reauthAt, testStatus, modelLock_*
export function getEffectiveStatus(connection) {
  if (!connection) return "unknown";
  if (connection.needsReauth) return "needs_reauth";

  if (connection.testStatus === "expired") return "expired";

  const lockedNow = Object.entries(connection).some(
    ([k, v]) => k.startsWith("modelLock_") && v && new Date(v).getTime() > Date.now(),
  );
  if (lockedNow) return connection.testStatus || "unavailable";

  // testStatus=unavailable without an active model-lock is stale — promote to
  // active (matches existing UI behavior so we don't introduce a regression).
  if (connection.testStatus === "unavailable") return "active";

  return connection.testStatus || "unknown";
}

export function isHealthyStatus(status) {
  return status === "active" || status === "success";
}

export function isErrorStatus(status) {
  return status === "error" || status === "expired" || status === "unavailable";
}
