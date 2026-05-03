import { NextResponse } from "next/server";
import { getWarmupRunsPage } from "@/lib/warmup/store";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = Number(searchParams.get("limit") || 20);
    const offset = Number(searchParams.get("offset") || 0);
    return NextResponse.json(await getWarmupRunsPage({ limit, offset }));
  } catch (error) {
    console.log("[WarmupAPI] GET runs failed:", error);
    return NextResponse.json({ error: "Failed to load warmup runs" }, { status: 500 });
  }
}
