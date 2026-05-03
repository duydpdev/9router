export const AUTH_COOKIE_NAME = "auth_token";
export const AUTH_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24;

function isHttpsUrl(value) {
  if (!value || typeof value !== "string") return false;

  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function shouldUseSecureAuthCookie({
  forceSecureCookie = false,
  forwardedProto,
  baseUrl,
} = {}) {
  if (forceSecureCookie) return true;
  if (typeof forwardedProto === "string" && forwardedProto.toLowerCase() === "https") {
    return true;
  }

  return isHttpsUrl(baseUrl);
}

export function buildAuthCookieOptions({ secure }) {
  return {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: AUTH_COOKIE_MAX_AGE_SECONDS,
  };
}

export function buildClearedAuthCookieOptions({ secure }) {
  return {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  };
}
