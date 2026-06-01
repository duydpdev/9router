import crypto from "node:crypto";

// Short, stable bucket id for a validated key — never the raw key. Shared by
// the rate-limit bucketing (botGuard) and the per-key budget monitor/alert so
// the masked-id derivation stays single-source (16-char sha256 slice).
export function keyHash(k) {
  return crypto.createHash("sha256").update(k).digest("hex").slice(0, 16);
}
