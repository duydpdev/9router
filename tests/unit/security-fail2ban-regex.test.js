import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Mirror of deploy/fail2ban/9router.filter failregex, with fail2ban's <HOST>
// expanded to an IPv4/IPv6 char class. Anchored to the fixed ts→ip field order.
const FAILREGEX = /^\{"ts":"[^"]*","ip":"([0-9.]+|[0-9a-fA-F:]+)",/;

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
