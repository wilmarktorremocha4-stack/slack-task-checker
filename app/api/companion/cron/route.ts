import { NextResponse } from "next/server";
import { processReminders, sendWeeklyDigest } from "@/lib/reminder-engine";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const timezone = process.env.TEAM_TIMEZONE ?? "America/New_York";
  const localTime = new Date(now.toLocaleString("en-US", { timeZone: timezone }));
  const dayOfWeek = localTime.getDay();
  const hour = localTime.getHours();
  const digestHour = parseInt(process.env.BRANDON_DIGEST_HOUR ?? "8", 10);

  const results = await processReminders();

  if (dayOfWeek === 1 && hour === digestHour) {
    await sendWeeklyDigest();
    return NextResponse.json({
      ok: true,
      digest_sent: true,
      reminders: results,
      processed_at: now.toISOString(),
    });
  }

  return NextResponse.json({
    ok: true,
    digest_sent: false,
    reminders: results,
    processed_at: now.toISOString(),
  });
}
