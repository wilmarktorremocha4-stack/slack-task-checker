import type { SupabaseClient } from "@supabase/supabase-js";
import type { Task } from "@/lib/supabase";
import {
  generateFollowupMessage,
  generateEscalationMessage,
} from "@/lib/openai-messages";
import { postThreadReply, sendDirectMessage, slackMention } from "@/lib/slack";
import {
  calculateNextFollowupAt,
  MAX_FOLLOWUPS,
  getFollowupUrgency,
} from "@/lib/followup-schedule";

export type FollowupResult = {
  task_id: string;
  action: string;
  assigned_to: string;
  urgency?: string;
  next_followup_at?: string;
  error?: string;
};

// Sends the next follow-up (or escalation) for a single task.
// Shared by the scheduled cron and the dashboard "Send follow-up now" button.
export async function sendFollowupForTask(
  supabase: SupabaseClient,
  task: Task,
  options: { manual?: boolean; now?: Date } = {}
): Promise<FollowupResult> {
  const now = options.now ?? new Date();
  const brandonUserId = process.env.SLACK_BRANDON_USER_ID!;
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
      `${slackMention(task.assigned_to_id)} I've reached the maximum follow-ups for this task without a response. I've notified ${task.assigned_by_name} directly.`,
      { broadcast: true }
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

    await supabase.from("task_comments").insert({
      task_id: task.id,
      author_type: "system",
      author_name: "System",
      content: `Task escalated after ${task.followup_count} follow-ups without a response. ${task.assigned_by_name} was notified by DM.`,
      sent_to_slack: true,
    });

    return {
      task_id: task.id,
      action: "escalated",
      assigned_to: task.assigned_to_name,
    };
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
    `${slackMention(task.assigned_to_id)} ${followupMessage}`
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

  await supabase.from("task_comments").insert({
    task_id: task.id,
    author_type: "system",
    author_name: "System",
    content: options.manual
      ? `Follow-up #${newFollowupCount} sent manually from the dashboard.`
      : `Follow-up #${newFollowupCount} (${urgency}) sent automatically.`,
    sent_to_slack: true,
  });

  return {
    task_id: task.id,
    action: `followup_${newFollowupCount}`,
    urgency,
    assigned_to: task.assigned_to_name,
    next_followup_at: nextFollowupAt?.toISOString(),
  };
}
