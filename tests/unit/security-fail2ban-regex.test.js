import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Mirror of deploy/fail2ban/9router.filter failregex, with fail2ban's <HOST>
// expanded to an IPv4/IPv6 char class. Anchored to the fixed ts→ip field order.
const FAILREGEX = /^\{"ts":"[^"]*","ip":"([0-9.]+|[0-9a-fA-F:]+)",/;

// Mirror of deploy/fail2ban/9router-probe.filter — same anchor PLUS kind:"probe"
// as the 3rd field, so only probe-flood events are banned.
const PROBE_FAILREGEX = /^\{"ts":"[^"]*","ip":"([0-9.]+|[0-9a-fA-F:]+)","kind":"probe",/;

let tmpDir;
let logBlocked;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "9r-f2b-"));
  process.env.DATA_DIR = tmpDir;
  ({ logBlocked } = await import("@/lib/security/auditLog"));
});

function lastLine() {
  const f = path.join(tmpDir, "logs", "bot-blocked.log");
  const lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
  return lines[lines.length - 1];
}

describe("fail2ban failregex vs real audit lines", () => {
  it("matches a real blocked line and captures the IP", () => {
    logBlocked({ ip: "203.0.113.7", kind: "probe", reason: "probe path /.env", path: "/.env", ua: "sqlmap" });
    const m = FAILREGEX.exec(lastLine());
    expect(m).not.toBeNull();
    expect(m[1]).toBe("203.0.113.7");
  });

  it("injection: forged \"ip\" inside ua does NOT hijack the captured IP", () => {
    logBlocked({
      ip: "203.0.113.7",
      kind: "bad-ua",
      reason: "scanner",
      path: "/",
      ua: 'x","ip":"9.9.9.9',
    });
    const m = FAILREGEX.exec(lastLine());
    expect(m[1]).toBe("203.0.113.7"); // real IP, not the injected 9.9.9.9
  });
});

describe("probe-flood failregex (9router-probe.filter)", () => {
  it("matches a probe line and captures the IP", () => {
    logBlocked({ ip: "198.51.100.4", kind: "probe", reason: "probe path /.env", path: "/.env", ua: "nikto" });
    const m = PROBE_FAILREGEX.exec(lastLine());
    expect(m).not.toBeNull();
    expect(m[1]).toBe("198.51.100.4");
  });

  it("ignores non-probe events (rate / bad-ua / ai-crawler)", () => {
    logBlocked({ ip: "198.51.100.5", kind: "rate", reason: "llm rate limit", path: "/v1/messages", ua: "curl" });
    expect(PROBE_FAILREGEX.exec(lastLine())).toBeNull();
    logBlocked({ ip: "198.51.100.6", kind: "bad-ua", reason: "scanner", path: "/", ua: "sqlmap" });
    expect(PROBE_FAILREGEX.exec(lastLine())).toBeNull();
  });

  it("injection: forged kind:\"probe\" inside ua does NOT match", () => {
    logBlocked({ ip: "198.51.100.7", kind: "rate", reason: "x", path: "/", ua: 'y","kind":"probe' });
    // kind is genuinely "rate"; the probe filter must not match the forged ua.
    expect(PROBE_FAILREGEX.exec(lastLine())).toBeNull();
  });
});
