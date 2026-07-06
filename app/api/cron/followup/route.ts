import { NextResponse } from "next/server";
import { createSupabaseAdmin, Task } from "@/lib/supabase";
import {
  generateFollowupMessage,
  generateEscalationMessage,
} from "@/lib/openai-messages";
import { postThreadReply, sendDirectMessage } from "@/lib/slack";
import {
  calculateNextFollowupAt,
  MAX_FOLLOWUPS,
  getFollowupUrgency,
} from "@/lib/followup-schedule";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createSupabaseAdmin();
  const now = new Date();
  const brandonUserId = process.env.SLACK_BRANDON_USER_ID!;

  const { data: dueTasks, error } = await supabase
    .from("tasks")
    .select("*")
    .eq("status", "active")
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

  const results = [];

  for (const task of dueTasks as Task[]) {
    try {
      const newFollowupCount = task.followup_count + 1;

      if (newFollowupCount > MAX_FOLLOWUPS) {
        const escalationMessage = await generateEscalationMessage({
          taskText: task.task_text,
          assigneeName: task.assigned_to_name,
          channelId: task.channel_id,
          threadTs: task.thread_ts,
          followupsSent: task.followup_count,
        });

        await sendDirectMessage(brandonUserId, escalationMessage);

        await postThreadReply(
          task.channel_id,
          task.thread_ts,
          `I've reached the maximum follow-ups for this task without a response from ${task.assigned_to_name}. I've notified ${task.assigned_by_name} directly.`
        );

        await supabase
          .from("tasks")
          .update({
            status: "escalated",
            escalated_at: now.toISOString(),
            next_followup_at: null,
          })
          .eq("id", task.id);

        await supabase.from("followup_logs").insert({
          task_id: task.id,
          followup_number: newFollowupCount,
          message_sent: escalationMessage,
          was_escalation: true,
        });

        results.push({
          task_id: task.id,
          action: "escalated",
          assigned_to: task.assigned_to_name,
        });

        continue;
      }

      const urgency = getFollowupUrgency(newFollowupCount);

      const followupMessage = await generateFollowupMessage({
        taskText: task.task_text,
        assigneeName: task.assigned_to_name,
        assignerName: task.assigned_by_name,
        followupNumber: newFollowupCount,
        urgency,
      });

      await postThreadReply(
        task.channel_id,
        task.thread_ts,
        followupMessage
      );

      const nextFollowupAt = calculateNextFollowupAt(newFollowupCount, now);

      await supabase
        .from("tasks")
        .update({
          followup_count: newFollowupCount,
          last_followup_at: now.toISOString(),
          next_followup_at: nextFollowupAt?.toISOString() ?? null,
        })
        .eq("id", task.id);

      await supabase.from("followup_logs").insert({
        task_id: task.id,
        followup_number: newFollowupCount,
        message_sent: followupMessage,
        was_escalation: false,
      });

      results.push({
        task_id: task.id,
        action: `followup_${newFollowupCount}`,
        urgency,
        assigned_to: task.assigned_to_name,
        next_followup_at: nextFollowupAt?.toISOString(),
      });

    } catch (err) {
      console.error(`Failed to process task ${task.id}:`, err);
      results.push({
        task_id: task.id,
        action: "error",
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
