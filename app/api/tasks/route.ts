import { NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase";
import { getSlackClient, getSlackUserName, postColoredMessage } from "@/lib/slack";
import { calculateNextFollowupAt } from "@/lib/followup-schedule";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status") ?? "active";
  const limit = parseInt(searchParams.get("limit") ?? "50");

  const supabase = createSupabaseAdmin();

  const query = supabase
    .from("tasks")
    .select(`
      *,
      followup_logs(*)
    `)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (status !== "all") {
    query.eq("status", status);
  }

  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    tasks: data,
    count: data?.length ?? 0,
    filter: status,
  });
}

export async function POST(request: Request) {
  const body = await request.json();
  const {
    assigneeIds,
    assigneeNames,
    taskText,
    followupSchedule,
    dueDate,
    // legacy single-assignee fields (Slack events path)
    assigneeId,
    assigneeName,
  } = body as {
    assigneeIds?: string[];
    assigneeNames?: string[];
    taskText: string;
    followupSchedule?: string[] | null;
    dueDate?: string | null;
    assigneeId?: string;
    assigneeName?: string;
  };

  // Normalise to arrays (support both single and multi-assignee)
  const ids: string[] = assigneeIds?.length ? assigneeIds : assigneeId ? [assigneeId] : [];
  const names: string[] = assigneeNames?.length ? assigneeNames : assigneeName ? [assigneeName] : [];

  if (!ids.length || !names.length || !taskText?.trim()) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  const channelId = process.env.SLACK_CHANNEL_ID!;
  const brandonUserId = process.env.SLACK_BRANDON_USER_ID!;

  const brandonName = await getSlackUserName(brandonUserId);

  // Determine next follow-up time
  let nextFollowupAt: Date | null = null;
  if (followupSchedule && followupSchedule.length > 0) {
    nextFollowupAt = new Date(followupSchedule[0]);
  } else {
    nextFollowupAt = calculateNextFollowupAt(0);
  }

  const mentions = ids.map(id => `<@${id}>`).join(" ");
  const nameList = names.join(", ");

  // Sort followup schedule chronologically (earliest first) before storing
  const sortedFollowupSchedule = followupSchedule?.length
    ? [...followupSchedule].sort((a, b) => new Date(a).getTime() - new Date(b).getTime())
    : null;

  // Server-side guard: no follow-up or due date may be in the past (60s grace)
  const cutoff = Date.now() - 60_000;
  if (sortedFollowupSchedule?.some(f => new Date(f).getTime() < cutoff)) {
    return NextResponse.json(
      { error: "Follow-up dates must be in the future" },
      { status: 400 }
    );
  }
  if (dueDate && new Date(dueDate).getTime() < cutoff) {
    return NextResponse.json(
      { error: "Due date must be in the future" },
      { status: 400 }
    );
  }
  // Guard: no follow-up may be after the due date
  if (dueDate && sortedFollowupSchedule?.some(f => new Date(f).getTime() > new Date(dueDate).getTime())) {
    return NextResponse.json(
      { error: "Follow-ups cannot be scheduled after the due date" },
      { status: 400 }
    );
  }

  // Recalculate next followup from sorted schedule
  if (sortedFollowupSchedule?.length) {
    nextFollowupAt = new Date(sortedFollowupSchedule[0]);
  }

  const dueDateLabel = dueDate
    ? new Date(dueDate).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true })
    : null;

  // Post the initial task message. No top-level `text`: Slack renders it in
  // ADDITION to attachments (doubling the message). The attachment `fallback`
  // covers push/desktop notifications instead.
  const slack = getSlackClient();
  const slackResult = await slack.chat.postMessage({
    channel: channelId,
    attachments: [
      {
        color: "#3B82F6",
        fallback: `📋 ${brandonName} assigned a task to ${nameList}: ${taskText.trim()}`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*New task assigned* by ${brandonName}\n*Assigned to:* ${mentions}\n\n*${taskText.trim()}*`,
            },
          },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `Reply *"done"* in this thread when complete${dueDateLabel ? ` · Due: ${dueDateLabel}` : ""}`,
              },
            ],
          },
        ],
      },
    ],
  });

  if (!slackResult.ok || !slackResult.ts) {
    return NextResponse.json({ error: "Failed to post to Slack" }, { status: 500 });
  }

  const messageTs = slackResult.ts;
  const supabase = createSupabaseAdmin();

  const { data: task, error } = await supabase
    .from("tasks")
    .insert({
      task_text: taskText.trim(),
      raw_message: taskText.trim(),
      assigned_to_id: ids[0],
      assigned_to_name: names[0],
      assignee_ids: ids,
      assignee_names: names,
      assigned_by_id: brandonUserId,
      assigned_by_name: brandonName,
      channel_id: channelId,
      message_ts: messageTs,
      thread_ts: messageTs,
      status: "active",
      followup_count: 0,
      max_followups: sortedFollowupSchedule ? sortedFollowupSchedule.length : 5,
      followup_schedule: sortedFollowupSchedule ?? null,
      due_date: dueDate ?? null,
      next_followup_at: nextFollowupAt?.toISOString() ?? null,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await supabase.from("task_comments").insert({
    task_id: task.id,
    author_type: "system",
    author_name: "System",
    content: `Task assigned to ${nameList} by ${brandonName} and posted to Slack.`,
    sent_to_slack: false,
  });

  return NextResponse.json({ task }, { status: 201 });
}
