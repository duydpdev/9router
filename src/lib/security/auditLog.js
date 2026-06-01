import fs from "node:fs";
import path from "node:path";
import { getDataDir } from "../dataDir.js";

const MAX_FIELD = 256;

// Cap attacker-controlled fields to bound log-amplification / disk fill.
function clip(v) {
  const s = v == null ? "" : String(v);
  return s.length > MAX_FIELD ? s.slice(0, MAX_FIELD) : s;
}

// Append one structured JSON line per blocked event. Consumed by fail2ban.
// Injection-safe: the whole record is JSON.stringify'd onto a single line, so
// embedded \n / \r / "}{" in ua/path are escaped inside string values and
// cannot forge a second log line. Never throws (logging must not break a block).
export function logBlocked({ ip, kind, reason, path: reqPath, ua }) {
  try {
    const record = {
      ts: new Date().toISOString(),
      ip: clip(ip),
      kind: clip(kind),
      reason: clip(reason),
      path: clip(reqPath),
      ua: clip(ua),
    };
    const dir = path.join(getDataDir(), "logs");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "bot-blocked.log"), JSON.stringify(record) + "\n");
  } catch {
    // swallow — audit logging is best-effort
  }
}
