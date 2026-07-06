import { NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase";
import { getSlackClient, getSlackUserName } from "@/lib/slack";
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
  const { assigneeId, assigneeName, taskText } = body as {
    assigneeId: string;
    assigneeName: string;
    taskText: string;
  };

  if (!assigneeId || !assigneeName || !taskText?.trim()) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  const channelId = process.env.SLACK_CHANNEL_ID!;
  const brandonUserId = process.env.SLACK_BRANDON_USER_ID!;

  const brandonName = await getSlackUserName(brandonUserId);

  const slack = getSlackClient();
  const slackResult = await slack.chat.postMessage({
    channel: channelId,
    text: `<@${assigneeId}> ${brandonName} has assigned you a task:\n> ${taskText.trim()}\n\nReply *"done"* in this thread when you've completed it.`,
    mrkdwn: true,
  });

  if (!slackResult.ok || !slackResult.ts) {
    return NextResponse.json({ error: "Failed to post to Slack" }, { status: 500 });
  }

  const messageTs = slackResult.ts;
  const nextFollowupAt = calculateNextFollowupAt(0);
  const supabase = createSupabaseAdmin();

  const { data: task, error } = await supabase
    .from("tasks")
    .insert({
      task_text: taskText.trim(),
      raw_message: taskText.trim(),
      assigned_to_id: assigneeId,
      assigned_to_name: assigneeName,
      assigned_by_id: brandonUserId,
      assigned_by_name: brandonName,
      channel_id: channelId,
      message_ts: messageTs,
      thread_ts: messageTs,
      status: "active",
      followup_count: 0,
      max_followups: 5,
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
    content: `Task created from dashboard by ${brandonName} and posted to Slack.`,
    sent_to_slack: false,
  });

  return NextResponse.json({ task }, { status: 201 });
}
