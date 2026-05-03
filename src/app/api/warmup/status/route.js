import { NextResponse } from "next/server";
import { getWarmupSchedulerStatus } from "@/lib/warmup/scheduler";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(getWarmupSchedulerStatus());
}
