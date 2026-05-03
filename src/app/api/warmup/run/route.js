import { NextResponse } from "next/server";
import { buildDedupeKey } from "@/lib/warmup/schedule";
import { getWarmupSchedules } from "@/lib/warmup/store";
import { runWarmupItems } from "@/lib/warmup/runner";
import { tryAcquireWarmupGuard, releaseWarmupGuard } from "@/lib/warmup/scheduler";

export const dynamic = "force-dynamic";

export async function POST(request) {
  if (!tryAcquireWarmupGuard()) {
    return NextResponse.json(
      { error: "scheduler tick in progress, try again shortly" },
      { status: 409 }
    );
  }
  try {
    const body = await request.json().catch(() => ({}));
    const schedules = await getWarmupSchedules();
    const scheduleIds = Array.isArray(body.scheduleIds) ? new Set(body.scheduleIds.map(String)) : null;
    const providerIds = Array.isArray(body.providerConnectionIds) ? new Set(body.providerConnectionIds.map(String)) : null;
    const now = new Date();
    const manualTime = now.toISOString();

    const items = [];
    for (const schedule of schedules) {
      if (scheduleIds && !scheduleIds.has(schedule.id)) continue;
      if (!schedule.enabled) continue;
      for (const providerConnectionId of schedule.providerConnectionIds) {
        if (providerIds && !providerIds.has(providerConnectionId)) continue;
        items.push({
          schedule,
          providerConnectionId,
          scheduledForUtc: manualTime,
          localDate: manualTime.slice(0, 10),
          localTime: "manual",
          timezone: schedule.timezone,
          dedupeKey: buildDedupeKey(schedule.id, providerConnectionId, manualTime.slice(0, 10), `manual-${now.getTime()}`),
        });
      }
    }

    const results = await runWarmupItems(items);
    return NextResponse.json({ results });
  } catch (error) {
    console.log("[WarmupAPI] manual run failed:", error);
    return NextResponse.json({ error: "Failed to run warmup" }, { status: 500 });
  } finally {
    releaseWarmupGuard();
  }
}
