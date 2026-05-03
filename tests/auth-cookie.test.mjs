import test from "node:test";
import assert from "node:assert/strict";

import {
  AUTH_COOKIE_MAX_AGE_SECONDS,
  buildAuthCookieOptions,
  buildClearedAuthCookieOptions,
  shouldUseSecureAuthCookie,
} from "../src/lib/authCookie.mjs";

test("uses secure cookies when reverse proxy forwards https", () => {
  assert.equal(
    shouldUseSecureAuthCookie({
      forwardedProto: "https",
      baseUrl: "http://localhost:20128",
    }),
    true
  );
});

test("uses secure cookies when public base url is https even without forwarded proto", () => {
  assert.equal(
    shouldUseSecureAuthCookie({
      forwardedProto: null,
      baseUrl: "https://nicerouter.mooo.com",
    }),
    true
  );
});

test("builds login cookie with stable auth attributes", () => {
  assert.deepEqual(buildAuthCookieOptions({ secure: true }), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: AUTH_COOKIE_MAX_AGE_SECONDS,
  });
});

test("builds logout cookie clearing options that match login scope", () => {
  assert.deepEqual(buildClearedAuthCookieOptions({ secure: true }), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
});
