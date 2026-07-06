import { NextResponse } from "next/server";
import { verifySlackSignature, getSlackUserName, postThreadReply } from "@/lib/slack";
import { createSupabaseAdmin } from "@/lib/supabase";
import { parseTaskFromMessage } from "@/lib/openai-messages";
import { calculateNextFollowupAt } from "@/lib/followup-schedule";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const rawBody = await request.text();

  const isValid = await verifySlackSignature(request, rawBody);
  if (!isValid) {
    console.error("Invalid Slack signature");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = JSON.parse(rawBody);

  if (body.type === "url_verification") {
    return NextResponse.json({ challenge: body.challenge });
  }

  const event = body.event;
  if (!event) {
    console.log("[slack] no event in body, body.type:", body.type);
    return NextResponse.json({ ok: true });
  }

  console.log("[slack] event received:", JSON.stringify({
    type: event.type,
    channel: event.channel,
    thread_ts: event.thread_ts,
    bot_id: event.bot_id,
    subtype: event.subtype,
    configured_channel: process.env.SLACK_CHANNEL_ID,
    channel_match: event.channel === process.env.SLACK_CHANNEL_ID,
  }));

  // Process asynchronously — do not await
  processSlackEvent(event).catch(err =>
    console.error("[slack] event processing error:", err)
  );

  return NextResponse.json({ ok: true });
}

async function processSlackEvent(event: Record<string, unknown>) {
  const supabase = createSupabaseAdmin();
  const monitoredChannelId = process.env.SLACK_CHANNEL_ID!;
  const brandonUserId = process.env.SLACK_BRANDON_USER_ID!;

  const isMention = event.type === "app_mention";
  const channelMatch = event.channel === monitoredChannelId;
  const noThread = !event.thread_ts;

  console.log("[slack] processing — isMention:", isMention, "channelMatch:", channelMatch, "noThread:", noThread);

  if (isMention && channelMatch && noThread) {
    console.log("[slack] → handling new task mention");
    await handleNewTaskMention(event, supabase, brandonUserId);
    return;
  }

  if (
    event.type === "message" &&
    event.thread_ts &&
    event.thread_ts !== event.ts &&
    !event.bot_id
  ) {
    console.log("[slack] → handling thread reply");
    await handleThreadReply(event, supabase);
    return;
  }

  console.log("[slack] → no handler matched for event type:", event.type);
}

async function handleNewTaskMention(
  event: Record<string, unknown>,
  supabase: ReturnType<typeof createSupabaseAdmin>,
  brandonUserId: string
) {
  const messageText = event.text as string;
  const channelId = event.channel as string;
  const messageTs = event.ts as string;
  const threadTs = (event.thread_ts as string) || (event.ts as string);
  const senderId = event.user as string;

  const mentionPattern = /<@([A-Z0-9]+)>/g;
  const mentions = [...messageText.matchAll(mentionPattern)]
    .map(m => m[1])
    .filter(id => id !== brandonUserId);

  const cleanMessage = messageText.replace(/<@[A-Z0-9]+>/g, "").trim();

  if (mentions.length === 0 || !cleanMessage) {
    await postThreadReply(
      channelId,
      threadTs,
      "Hey! To assign a task, mention me and tag the person: `@TaskBot @teammate task description here`"
    );
    return;
  }

  const assigneeId = mentions[0];
  const [assigneeName, assignerName] = await Promise.all([
    getSlackUserName(assigneeId),
    getSlackUserName(senderId),
  ]);

  const parsed = await parseTaskFromMessage(cleanMessage, assigneeName);

  if (!parsed || !parsed.hasTask || !parsed.taskText) {
    await postThreadReply(
      channelId,
      threadTs,
      `Got it ${assignerName}! But I couldn't identify a clear task. Try: \`@TaskBot @${assigneeName} needs to [specific task description]\``
    );
    return;
  }

  const nextFollowupAt = calculateNextFollowupAt(0);

  const { error } = await supabase
    .from("tasks")
    .insert({
      task_text: parsed.taskText,
      raw_message: messageText,
      assigned_to_id: assigneeId,
      assigned_to_name: assigneeName,
      assigned_by_id: senderId,
      assigned_by_name: assignerName,
      channel_id: channelId,
      message_ts: messageTs,
      thread_ts: threadTs,
      status: "active",
      followup_count: 0,
      max_followups: 5,
      next_followup_at: nextFollowupAt?.toISOString() ?? null,
    })
    .select()
    .single();

  if (error) {
    console.error("Failed to save task:", error);
    return;
  }

  await postThreadReply(
    channelId,
    threadTs,
    `✅ Got it! I've logged this task for *${assigneeName}*:\n> ${parsed.taskText}\n\nI'll follow up automatically until it's confirmed complete. ${assigneeName}, just reply *"done"* in this thread when you've finished.`
  );
}

async function handleThreadReply(
  event: Record<string, unknown>,
  supabase: ReturnType<typeof createSupabaseAdmin>
) {
  const threadTs = event.thread_ts as string;
  const messageText = ((event.text as string) || "").toLowerCase().trim();
  const userId = event.user as string;

  const { data: task } = await supabase
    .from("tasks")
    .select("*")
    .eq("thread_ts", threadTs)
    .eq("status", "active")
    .single();

  if (!task) return;

  const isAssignee = userId === task.assigned_to_id;
  const isDoneMessage =
    /\b(done|completed|finished|complete|all done|sorted|did it|it's done|it is done)\b/.test(
      messageText
    );

  if (isAssignee && isDoneMessage) {
    await supabase
      .from("tasks")
      .update({
        status: "completed",
        completed_at: new Date().toISOString(),
        next_followup_at: null,
      })
      .eq("id", task.id);

    await postThreadReply(
      task.channel_id,
      task.thread_ts,
      `🎉 Great work ${task.assigned_to_name}! Task marked as complete:\n> ${task.task_text}\n\nI'll stop the follow-ups. Nice one!`
    );
  }
}
