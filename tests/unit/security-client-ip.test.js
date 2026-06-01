import { describe, it, expect } from "vitest";
import { getClientIp, getTrustedClientIp } from "@/lib/security/clientIp";

// Minimal Request-like stub: only headers.get is used.
function req(headers = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { headers: { get: (k) => lower[k.toLowerCase()] ?? null } };
}

describe("getClientIp (unchanged login behavior)", () => {
  it("takes x-forwarded-for first hop and trims it", () => {
    expect(getClientIp(req({ "x-forwarded-for": " 1.2.3.4 , 5.6.7.8" }))).toBe("1.2.3.4");
  });

  it("falls back to x-real-ip when no xff", () => {
    expect(getClientIp(req({ "x-real-ip": "9.9.9.9" }))).toBe("9.9.9.9");
  });

  it("returns 'unknown' when nothing present", () => {
    expect(getClientIp(req())).toBe("unknown");
  });
});

describe("getTrustedClientIp (botGuard, trustProxy-aware)", () => {
  it("trustProxy:true → honors xff first hop", () => {
    expect(getTrustedClientIp(req({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }), { trustProxy: true })).toBe("1.2.3.4");
  });

  it("trustProxy:false → still derives an IP (no socket IP in middleware) but value is untrusted", () => {
    // We cannot get a socket IP in Next middleware; we still bucket by the parsed value.
    expect(getTrustedClientIp(req({ "x-forwarded-for": "1.2.3.4" }), { trustProxy: false })).toBe("1.2.3.4");
  });

  it("defaults trustProxy to false when opts omitted", () => {
    expect(getTrustedClientIp(req({ "x-real-ip": "9.9.9.9" }))).toBe("9.9.9.9");
  });
});
