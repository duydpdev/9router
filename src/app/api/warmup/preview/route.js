import { NextResponse } from "next/server";
import { getWarmupPreview } from "@/lib/warmup/store";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const days = Number(searchParams.get("days") || 7);
    return NextResponse.json({ preview: await getWarmupPreview(days) });
  } catch (error) {
    console.log("[WarmupAPI] GET preview failed:", error);
    return NextResponse.json({ error: "Failed to load warmup preview" }, { status: 500 });
  }
}
