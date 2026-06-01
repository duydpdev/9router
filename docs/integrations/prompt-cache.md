# Opt-In Prompt Cache (Embeddings)

9Router can cache `/v1/embeddings` responses in memory and replay them for
identical follow-up requests. **Disabled by default** — a request without the
opt-in header behaves exactly as before. Enable per request with a single
header.

## When to enable

Embeddings are deterministic (same input → same vector), so repeated calls are
pure waste: test loops, re-indexing the same corpus, agent retries, warm-up
probes. Caching those turns N upstream calls into 1.

## How to enable

Send the `x-router-cache` header with a TTL in seconds:

```bash
curl http://localhost:20128/v1/embeddings \
  -H "Content-Type: application/json" \
  -H "x-router-cache: ttl=300" \
  -d '{"model": "openai/text-embedding-3-small", "input": "hello world"}'
```

- First call → forwarded upstream, response header `x-router-cache-hit: false`.
- Second identical call within 300s → served from cache, `x-router-cache-hit: true`.

### Header reference

| Header value                 | Effect                                            |
| ---------------------------- | ------------------------------------------------- |
| `x-router-cache: ttl=300`    | Cache for 300 seconds                             |
| `x-router-cache: no-store`   | Disable caching for this request                  |
| `x-router-cache: ttl=300, no-store` | `no-store` wins → disabled                  |
| (header absent / malformed)  | Disabled (pre-feature behavior)                   |

TTL is clamped to `1..86400` (max 1 day). `ttl=0` or non-integer → disabled.

## Cache key

Strict, per-model. The key is a SHA-256 of:

```
model + input + encoding_format + dimensions
```

Any difference — including `input` array order — is a cache miss. There is **no**
cross-provider or cross-model dedup.

## Bypass rules

Even with the header present, caching is skipped when:

| Condition                          | `bypassReason`     | Why                                   |
| ---------------------------------- | ------------------ | ------------------------------------- |
| `no-store` in header               | `explicit_no_store`| Caller opt-out                        |
| `input` is a token array (`number[]` / `number[][]`) | `tokenized_input` | Blows byte budget, hash cost prohibitive |
| `JSON.stringify(input)` > 100KB    | `oversize_input`   | Hash-input cap                        |
| Upstream response is non-200       | —                  | Only successful responses are cached  |

## Response headers

| Header                | Values         |
| --------------------- | -------------- |
| `x-router-cache-hit`  | `true` / `false` |

## Configuration

| Env var                  | Default        | Purpose                              |
| ------------------------ | -------------- | ------------------------------------ |
| `PROMPT_CACHE_MAX_BYTES` | `524288000` (500MB) | Total in-memory cache budget. LRU evicts oldest when exceeded. Size to your deployment's memory headroom — over-committing risks Node OOM. |

## Limitations (v1)

- **In-memory only.** Cache lives in the Node process and clears on restart.
- **NOT compatible with serverless.** Vercel / Lambda tear down the JS context
  between invocations, so the cache is cold on nearly every request → hit rate
  ≈ 0. Use a long-lived process (`npm start`, Docker, self-hosted VM).
- **Embeddings only.** Chat completions are not cached in v1 (deferred — chat
  has provider-fallback and format-translation correctness questions to resolve
  first).
- **No invalidation API.** TTL + restart only.
- **No metrics UI.** Stats available via the in-process `getPromptCache().stats()`.
- **Process-wide, no per-user isolation.** Cached `input` text sits in memory —
  treat cache memory as sensitive. Revisit when multi-user lands.

## Source of truth

Bypass and parsing rules live in `src/sse/services/cache-directive.js`; the
cache itself in `src/sse/services/prompt-cache.js`; wiring in
`src/app/api/v1/embeddings/route.js`.
