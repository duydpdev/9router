import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let tmpDir;
let logBlocked;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "9r-audit-"));
  process.env.DATA_DIR = tmpDir;
  // Fresh import so module reads the env-driven path lazily per call.
  ({ logBlocked } = await import("@/lib/security/auditLog"));
});

afterAll(() => {
  delete process.env.DATA_DIR;
});

function readLines() {
  const f = path.join(tmpDir, "logs", "bot-blocked.log");
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
}

describe("auditLog.logBlocked", () => {
  it("writes one parseable JSON line with all fields", () => {
    logBlocked({ ip: "1.2.3.4", kind: "probe", reason: "probe path /.env", path: "/.env", ua: "sqlmap" });
    const lines = readLines();
    expect(lines).toHaveLength(1);
    const o = JSON.parse(lines[0]);
    expect(o).toMatchObject({ ip: "1.2.3.4", kind: "probe", path: "/.env", ua: "sqlmap" });
    expect(o.ts).toBeTruthy();
  });

  it("injection: newline/CRLF/brace payload yields exactly ONE line", () => {
    const evil = 'sqlmap\n{"ip":"9.9.9.9","kind":"probe"}\r\n}{';
    logBlocked({ ip: "1.2.3.4", kind: "bad-ua", reason: "x", path: "/", ua: evil });
    const lines = readLines();
    expect(lines).toHaveLength(1);                 // no forged second line
    const o = JSON.parse(lines[0]);
    expect(o.ua).toBe(evil.slice(0, 256));         // literal payload preserved (+truncated)
    expect(o.ip).toBe("1.2.3.4");                  // not the injected 9.9.9.9
  });

  it("truncates ua and path to 256 chars", () => {
    logBlocked({ ip: "1.2.3.4", kind: "bad-ua", reason: "x", path: "/" + "a".repeat(5000), ua: "b".repeat(5000) });
    const o = JSON.parse(readLines()[0]);
    expect(o.ua.length).toBeLessThanOrEqual(256);
    expect(o.path.length).toBeLessThanOrEqual(256);
  });

  it("does not throw on write error (unwritable path)", () => {
    process.env.DATA_DIR = "/proc/nonexistent-readonly-xyz";
    expect(() => logBlocked({ ip: "1.2.3.4", kind: "probe", reason: "x", path: "/", ua: "u" })).not.toThrow();
  });
});
