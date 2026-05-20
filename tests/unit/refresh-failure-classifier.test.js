import { describe, it, expect } from "vitest";
import { isFatalRefreshFailure } from "@/lib/oauth/refresh-failure-classifier.js";

describe("isFatalRefreshFailure", () => {
  it("string 'invalid_grant' → invalid_grant", () => {
    expect(isFatalRefreshFailure("invalid_grant")).toBe("invalid_grant");
  });

  it("string 'invalid_request' → invalid_grant", () => {
    expect(isFatalRefreshFailure("invalid_request")).toBe("invalid_grant");
  });

  it("string 'refresh_token_reused' → refresh_family_revoked", () => {
    expect(isFatalRefreshFailure("refresh_token_reused")).toBe("refresh_family_revoked");
  });

  it("string 'token has been used' → refresh_family_revoked", () => {
    expect(isFatalRefreshFailure('error: "token has been used"')).toBe("refresh_family_revoked");
  });

  it("string 'token_expired' → invalid_grant", () => {
    expect(isFatalRefreshFailure("token_expired")).toBe("invalid_grant");
  });

  it("string 'temporarily_unavailable' → null (transient)", () => {
    expect(isFatalRefreshFailure("temporarily_unavailable")).toBeNull();
  });

  it("string 'secondary_rate_limit' → null", () => {
    expect(isFatalRefreshFailure("secondary_rate_limit")).toBeNull();
  });

  it("Codex tagged unrecoverable + refresh_token_reused → refresh_family_revoked", () => {
    expect(
      isFatalRefreshFailure({ error: "unrecoverable_refresh_error", code: "refresh_token_reused" }),
    ).toBe("refresh_family_revoked");
  });

  it("Codex tagged unrecoverable + invalid_grant → invalid_grant", () => {
    expect(
      isFatalRefreshFailure({ error: "unrecoverable_refresh_error", code: "invalid_grant" }),
    ).toBe("invalid_grant");
  });

  it("Codex tagged unrecoverable + token_expired → invalid_grant", () => {
    expect(
      isFatalRefreshFailure({ error: "unrecoverable_refresh_error", code: "token_expired" }),
    ).toBe("invalid_grant");
  });

  it("{ error: 'invalid_grant' } → invalid_grant", () => {
    expect(isFatalRefreshFailure({ error: "invalid_grant" })).toBe("invalid_grant");
  });

  it("refactored refresh primitive shape — body contains invalid_grant → invalid_grant", () => {
    expect(
      isFatalRefreshFailure({
        error: "refresh_failed",
        status: 400,
        body: '{"error":"invalid_grant","error_description":"Bad refresh token"}',
      }),
    ).toBe("invalid_grant");
  });

  it("refactored refresh primitive shape — body says temporarily_unavailable → null", () => {
    expect(
      isFatalRefreshFailure({
        error: "refresh_failed",
        status: 400,
        body: '{"error":"temporarily_unavailable"}',
      }),
    ).toBeNull();
  });

  it("refactored refresh primitive shape — body unrecognized 4xx → null (per F8)", () => {
    expect(
      isFatalRefreshFailure({
        error: "refresh_failed",
        status: 403,
        body: '{"error":"forbidden","message":"some odd condition"}',
      }),
    ).toBeNull();
  });

  it("HTTP 500 / ECONNRESET → null", () => {
    expect(isFatalRefreshFailure({ message: "ECONNRESET" })).toBeNull();
    expect(isFatalRefreshFailure({ error: "refresh_failed", status: 500, body: "" })).toBeNull();
  });

  it("null / undefined → null", () => {
    expect(isFatalRefreshFailure(null)).toBeNull();
    expect(isFatalRefreshFailure(undefined)).toBeNull();
  });

  it("Error with invalid_grant message → invalid_grant", () => {
    expect(isFatalRefreshFailure(new Error("invalid_grant: refresh token rejected"))).toBe("invalid_grant");
  });
});
