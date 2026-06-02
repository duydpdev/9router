// Next.js server bootstrap hook. Fires once on server start regardless of
// which route (page or API) handles the first request. Previously
// initializeApp() was triggered as a side-effect of importing
// src/app/layout.js, which only loads on app-router page hits — pure
// API/proxy traffic (warmup, MITM, /v1/*) would never start the warmup
// scheduler.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    // Importing bootstrap runs initializeApp() once — it self-guards via
    // global.__appBootstrapped, so this does NOT double-init alongside the
    // app/layout.js import. The import is fire-and-forget internally (bootstrap
    // does not await initializeApp), so register() returns without blocking the
    // server becoming ready.
    await import("@/shared/services/bootstrap");
  } catch (error) {
    console.log("[Instrumentation] bootstrap failed:", error?.message || error);
  }
}
