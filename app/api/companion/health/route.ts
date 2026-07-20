import { NextResponse } from "next/server";
import { createPersonalSupabaseAdmin } from "@/lib/supabase-personal";

export async function GET() {
  const checks: Record<string, boolean> = {
    slack_token:          !!process.env.SLACK_BOT_TOKEN,
    slack_signing_secret: !!process.env.SLACK_SIGNING_SECRET,
    slack_channel:        !!process.env.SLACK_CHANNEL_ID,
    slack_brandon_id:     !!process.env.SLACK_BRANDON_USER_ID,
    supabase_url:         !!process.env.NEXT_PUBLIC_SUPABASE_URL,
    supabase_key:         !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    openai_key:           !!process.env.OPENAI_API_KEY,
    cron_secret:          !!process.env.CRON_SECRET,
    team_supabase:        !!process.env.TEAM_SUPABASE_URL,
  };

  try {
    const supabase = createPersonalSupabaseAdmin();
    const { error } = await supabase.from("ideas").select("id").limit(1);
    checks.supabase_connection = !error;
  } catch {
    checks.supabase_connection = false;
  }

  const allHealthy = Object.values(checks).every(Boolean);

  return NextResponse.json(
    { status: allHealthy ? "healthy" : "degraded", checks, timestamp: new Date().toISOString() },
    { status: allHealthy ? 200 : 500 }
  );
}
