// Next.js server bootstrap hook. Fires once on server start regardless of
// which route (page or API) handles the first request. Previously
// initializeApp() was triggered as a side-effect of importing
// src/app/layout.js, which only loads on app-router page hits — pure
// API/proxy traffic (warmup, MITM, /v1/*) would never start the warmup
// scheduler.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const mod = await import("@/server-init");
    const ensure = mod.ensureAppInitialized || mod.default;
    if (typeof ensure === "function") await ensure();
  } catch (error) {
    console.log("[Instrumentation] bootstrap failed:", error?.message || error);
  }
}
