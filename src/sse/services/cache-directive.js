import * as log from "../utils/logger.js";

const TTL_MIN = 1;
const TTL_MAX = 86400; // 1 day
const MAX_INPUT_BYTES = 100_000; // 100KB hash-input cap for embeddings

/**
 * @typedef {Object} CacheDirective
 * @property {boolean} enabled       true only if header opt-in AND no bypass
 * @property {number}  ttl           seconds (0 when disabled)
 * @property {string|null} bypassReason  set when a forced bypass fired (for logging)
 */

/** Case-insensitive header read. Production + tests both use Web `Headers`. */
const getHeader = (req, name) => req.headers?.get?.(name.toLowerCase()) ?? null;

const disabled = (bypassReason = null) => ({ enabled: false, ttl: 0, bypassReason });

/**
 * Parse the `x-router-cache` header value.
 * Recognized tokens: `ttl=<n>` and `no-store`. Unknown tokens ignored (forward
 * compatible). Returns `{ ttl, noStore, valid }`.
 */
const parseCacheHeader = (value) => {
  if (!value || typeof value !== "string") return { ttl: 0, noStore: false, valid: false };
  let ttl = 0;
  let noStore = false;
  let sawTtl = false;
  for (const raw of value.split(",")) {
    const token = raw.trim().toLowerCase();
    if (token === "no-store") {
      noStore = true;
    } else if (token.startsWith("ttl=")) {
      const n = Number(token.slice(4));
      if (Number.isInteger(n) && n >= 0) {
        ttl = Math.min(Math.max(n, 0), TTL_MAX);
        sawTtl = true;
      } else {
        log.warn("CACHE", `Malformed ttl in x-router-cache: "${raw.trim()}"`);
        return { ttl: 0, noStore, valid: false };
      }
    }
    // unknown tokens: skip silently (forward compatible)
  }
  return { ttl, noStore, valid: sawTtl || noStore };
};

/**
 * Detect pre-tokenized embeddings input. OpenAI accepts `input` as a string,
 * string[], number[] (one tokenized doc), or number[][] (batch tokenized).
 * Token-array forms must bypass the cache — they blow the byte budget and the
 * hash cost is prohibitive (red-team finding #10).
 *
 * @param {*} input  the embeddings request `input` field
 * @returns {boolean} true if `input` is number[] or number[][]
 */
export const isTokenInput = (input) => {
  if (!Array.isArray(input) || input.length === 0) return false;
  const first = input[0];
  if (typeof first === "number") return true; // number[]
  if (Array.isArray(first) && typeof first[0] === "number") return true; // number[][]
  return false;
};

/**
 * Compute the cache directive for a request. Header opt-in first; if enabled,
 * run the (kind-specific) bypass checks. Any bypass beats the opt-in.
 *
 * @param {Request|{headers:Headers}} req
 * @param {object} body  already-parsed request body
 * @param {"embeddings"} kind  v1 supports embeddings only
 * @returns {CacheDirective}
 */
export const parseCacheDirective = (req, body, kind) => {
  const headerValue = getHeader(req, "x-router-cache");
  const { ttl, noStore, valid } = parseCacheHeader(headerValue);

  if (noStore) return disabled("explicit_no_store");
  if (!valid || ttl < TTL_MIN) return disabled();

  if (kind === "embeddings") {
    if (isTokenInput(body.input)) return disabled("tokenized_input");
    // True byte size (UTF-8), not UTF-16 char count — a multibyte payload
    // would otherwise slip past a char-based cap at up to ~4x the real bytes.
    if (Buffer.byteLength(JSON.stringify(body.input ?? null)) > MAX_INPUT_BYTES) {
      return disabled("oversize_input");
    }
  }

  return { enabled: true, ttl, bypassReason: null };
};
