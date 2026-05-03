import { NextResponse } from "next/server";
import { getWarmupState, saveWarmupSchedules } from "@/lib/warmup/store";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getWarmupState());
  } catch (error) {
    console.log("[WarmupAPI] GET schedules failed:", error);
    return NextResponse.json({ error: "Failed to load warmup schedules" }, { status: 500 });
  }
}

export async function PUT(request) {
  try {
    const body = await request.json();
    const state = await saveWarmupSchedules(body.schedules || []);
    return NextResponse.json(state);
  } catch (error) {
    const status = error.statusCode || 500;
    return NextResponse.json({ error: error.message || "Failed to save warmup schedules" }, { status });
  }
}
