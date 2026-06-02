import { fetchUsageForConnection } from "@/lib/usage/fetch-usage-for-connection";

/**
 * GET /api/usage/[connectionId] - Get usage data for a specific connection.
 * Orchestration (proxy resolve → token refresh → fetch → auth-expired retry)
 * lives in the shared fetchUsageForConnection helper, reused by the warmup runner.
 */
export async function GET(request, { params }) {
  try {
    const { connectionId } = await params;
    const { usage } = await fetchUsageForConnection(connectionId);
    return Response.json(usage);
  } catch (error) {
    if (error.code === "CONNECTION_NOT_FOUND") {
      return Response.json({ error: "Connection not found" }, { status: 404 });
    }
    if (error.code === "REFRESH_FAILED") {
      console.error("[Usage API] Credential refresh failed:", error.message);
      return Response.json({ error: error.message }, { status: 401 });
    }
    console.warn(`[Usage] ${error.message}`);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
