import { NextResponse } from "next/server";
import { createSupabaseAdmin, Task } from "@/lib/supabase";
import { sendFollowupForTask, FollowupResult } from "@/lib/followup-engine";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createSupabaseAdmin();
  const now = new Date();

  // Both fresh tasks and reopened (revision_requested) tasks get follow-ups
  const { data: dueTasks, error } = await supabase
    .from("tasks")
    .select("*")
    .in("status", ["active", "revision_requested"])
    .lte("next_followup_at", now.toISOString())
    .not("next_followup_at", "is", null);

  if (error) {
    console.error("Failed to fetch due tasks:", error);
    return NextResponse.json({ error: "Database error" }, { status: 500 });
  }

  if (!dueTasks || dueTasks.length === 0) {
    return NextResponse.json({
      ok: true,
      message: "No tasks due for follow-up",
      checked_at: now.toISOString(),
    });
  }

  const results: FollowupResult[] = [];

  for (const task of dueTasks as Task[]) {
    try {
      results.push(await sendFollowupForTask(supabase, task, { now }));
    } catch (err) {
      console.error(`Failed to process task ${task.id}:`, err);
      results.push({
        task_id: task.id,
        action: "error",
        assigned_to: task.assigned_to_name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return NextResponse.json({
    ok: true,
    processed: results.length,
    results,
    processed_at: now.toISOString(),
  });
}
