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

  // Also catch active tasks that are 5+ days old (overdue escalation check)
  const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
  const { data: overdueTasksRaw } = await supabase
    .from("tasks")
    .select("*")
    .in("status", ["active", "revision_requested"])
    .lt("created_at", fiveDaysAgo.toISOString())
    .is("escalated_at", null);

  // Merge with dueTasks, deduplicate by id
  const allTaskIds = new Set((dueTasks ?? []).map(t => (t as Task).id));
  const extraTasks = (overdueTasksRaw ?? []).filter(
    t => !allTaskIds.has((t as Task).id)
  );
  const allTasksToProcess = [...(dueTasks ?? []), ...extraTasks] as Task[];

  if (allTasksToProcess.length === 0) {
    return NextResponse.json({
      ok: true,
      message: "No tasks due for follow-up",
      checked_at: now.toISOString(),
    });
  }

  const results: FollowupResult[] = [];

  for (const task of allTasksToProcess) {
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
