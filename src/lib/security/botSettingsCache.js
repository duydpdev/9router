import { getSettings } from "@/lib/localDb";

// ~5s cache of the botProtection settings block. botGuard runs on the hot /v1
// path and the budget monitor runs on every post-completion usage event — both
// would otherwise hit sqlite per call. Lives in its own module (no next/server
// import) so the monitor can read settings without pulling the Next middleware
// graph into its dependency tree.
let _cache = null;
let _cacheAt = 0;

export async function getCachedBotSettings(now = Date.now) {
  const t = now();
  if (_cache && t - _cacheAt < 5000) return _cache;
  const s = await getSettings();
  _cache = s?.botProtection || null;
  _cacheAt = t;
  return _cache;
}

export const __test__ = {
  resetCache: () => {
    _cache = null;
    _cacheAt = 0;
  },
};
