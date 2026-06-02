/**
 * Heuristic request complexity classifier — zero tokens, zero network.
 *
 * Buckets a request into "simple" | "complex" using char-count + cheap regex
 * over ONLY the last user turn (bounded copy). Used by the smart-router cost
 * tier to decide whether to try cheap (OAuth/free) or capable (metered) models
 * first. Pure function: same input → same output, no module state.
 */

const DEFAULT_THRESHOLD = 1500; // approx-token cutoff between simple/complex
const SCAN_CHAR_CAP = 8 * 1024; // never inspect more than 8KB of message text (DoS guard)

// Linear alternation, no nested quantifiers → no catastrophic backtracking.
const CODE_SIGNAL = /```|\bfunction\b|\bclass\b|\bimport\b|=>/;

/**
 * Pull readable text out of a single message-shaped value.
 * Content may be a plain string or an array of parts ({ type:"text", text } or
 * Gemini { text }). Returns "" for anything unrecognized.
 */
function textFromContent(content) {
  if (typeof content === "string") return content.slice(0, SCAN_CHAR_CAP);
  if (Array.isArray(content)) {
    let out = "";
    for (const part of content) {
      if (typeof part === "string") out += part;
      else if (part && typeof part.text === "string") out += part.text;
      if (out.length >= SCAN_CHAR_CAP) break; // bound concatenation cost, not just the scan
    }
    return out;
  }
  return "";
}

/**
 * Return the last user-authored turn's text across every supported body shape:
 *  - OpenAI chat / Claude:        body.messages[]  ({ role, content })
 *  - Gemini:                      body.contents[]  ({ role, parts:[{text}] })
 *  - OpenAI Responses API/Cursor: body.input[]     (string OR { role, content })
 * Only the LAST user turn is read — bounds work and is the signal that matters.
 * Empty/unknown shape → "" (caller biases to "complex" on empty).
 */
function extractLastUserText(body) {
  if (!body || typeof body !== "object") return "";

  // OpenAI chat / Claude
  if (Array.isArray(body.messages)) {
    for (let i = body.messages.length - 1; i >= 0; i--) {
      const msg = body.messages[i];
      if (msg && msg.role === "user") return textFromContent(msg.content);
    }
    return "";
  }

  // Gemini
  if (Array.isArray(body.contents)) {
    for (let i = body.contents.length - 1; i >= 0; i--) {
      const turn = body.contents[i];
      // Gemini omits role for single-turn; treat last turn as the user signal.
      if (turn && (turn.role === "user" || !turn.role)) {
        return textFromContent(turn.parts);
      }
    }
    return "";
  }

  // OpenAI Responses API / Cursor — body.input can be a bare string or an array.
  if (typeof body.input === "string") return body.input;
  if (Array.isArray(body.input)) {
    for (let i = body.input.length - 1; i >= 0; i--) {
      const item = body.input[i];
      if (typeof item === "string") return item;
      if (item && item.role === "user") return textFromContent(item.content);
    }
    return "";
  }

  return "";
}

/**
 * Classify request complexity.
 * @param {object} body - request body (any supported shape)
 * @param {number} [threshold] - approx-token cutoff; invalid values self-clamp.
 * @returns {"simple"|"complex"}
 */
export function classifyComplexity(body, threshold = DEFAULT_THRESHOLD) {
  // Settings path does not validate this value — clamp here so NaN/0/"x" can
  // never flip behavior to "everything is simple".
  const t = Number.isFinite(threshold) && threshold > 0 ? threshold : DEFAULT_THRESHOLD;
  const text = extractLastUserText(body).slice(0, SCAN_CHAR_CAP); // bounded copy
  // Empty/unreadable text means we couldn't parse the request shape — bias to
  // "complex" so an unrecognized request gets the stronger model, not the cheap
  // tier. (A genuine empty request is rare; a parse miss is the real case.)
  if (!text) return "complex";
  const approxTokens = Math.ceil(text.length / 4); // char/4 ≈ tokens (coarse split only)
  const hasTool = Array.isArray(body?.tools) && body.tools.length > 0;
  const hasCode = CODE_SIGNAL.test(text);
  return approxTokens < t && !hasTool && !hasCode ? "simple" : "complex";
}

// Exported for unit tests (bounded-scan + shape coverage assertions).
export { extractLastUserText, SCAN_CHAR_CAP, DEFAULT_THRESHOLD };
