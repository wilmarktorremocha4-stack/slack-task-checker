import { NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { verifySlackSignature, getSlackUserName, postThreadReply, getSlackClient } from "@/lib/slack";
import { createSupabaseAdmin } from "@/lib/supabase";
import { parseTaskFromMessage } from "@/lib/openai-messages";
import { calculateNextFollowupAt } from "@/lib/followup-schedule";

export const runtime = "nodejs";
export const maxDuration = 30;

// Cache bot user ID across invocations (warm starts)
let cachedBotUserId = "";

async function getBotUserId(): Promise<string> {
  if (cachedBotUserId) return cachedBotUserId;
  try {
    const result = await getSlackClient().auth.test();
    cachedBotUserId = result.user_id ?? "";
    console.log("[slack] bot user ID cached:", cachedBotUserId);
  } catch (err) {
    console.error("[slack] failed to get bot user ID:", err);
  }
  return cachedBotUserId;
}

export async function POST(request: Request) {
  const rawBody = await request.text();

  const isValid = await verifySlackSignature(request, rawBody);
  if (!isValid) {
    console.error("[slack] invalid signature");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = JSON.parse(rawBody);

  if (body.type === "url_verification") {
    return NextResponse.json({ challenge: body.challenge });
  }

  const event = body.event;
  if (!event) {
    return NextResponse.json({ ok: true });
  }

  console.log("[slack] event:", event.type, "channel:", event.channel, "bot_id:", event.bot_id ?? "none", "thread_ts:", event.thread_ts ?? "none");

  waitUntil(
    processSlackEvent(event).catch(err =>
      console.error("[slack] unhandled error:", err)
    )
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

  if (isMention && channelMatch && noThread) {
    console.log("[slack] → new task mention");
    await handleNewTaskMention(event, supabase, brandonUserId);
    return;
  }

  if (event.type === "message" && event.thread_ts && event.thread_ts !== event.ts && !event.bot_id) {
    console.log("[slack] → thread reply");
    await handleThreadReply(event, supabase);
    return;
  }
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

  console.log("[task] step 1 — raw message:", messageText);

  const botUserId = await getBotUserId();

  const mentionPattern = /<@([A-Z0-9]+)>/g;
  const mentions = [...messageText.matchAll(mentionPattern)]
    .map(m => m[1])
    .filter(id => id !== brandonUserId && id !== botUserId);

  const cleanMessage = messageText.replace(/<@[A-Z0-9]+>/g, "").trim();

  console.log("[task] step 2 — mentions:", mentions, "cleanMessage:", cleanMessage);

  if (mentions.length === 0 || !cleanMessage) {
    console.log("[task] no mentions or empty message — sending help reply");
    await postThreadReply(
      channelId,
      threadTs,
      "Hey! To assign a task, mention me and tag the person: `@TaskBot @teammate task description here`"
    );
    return;
  }

  const assigneeId = mentions[0];
  console.log("[task] step 3 — assigneeId:", assigneeId, "senderId:", senderId);

  let assigneeName: string, assignerName: string;
  try {
    [assigneeName, assignerName] = await Promise.all([
      getSlackUserName(assigneeId),
      getSlackUserName(senderId),
    ]);
    console.log("[task] step 4 — assigneeName:", assigneeName, "assignerName:", assignerName);
  } catch (err) {
    console.error("[task] step 4 failed — getSlackUserName error:", err);
    return;
  }

  let parsed: { taskText: string; hasTask: boolean } | null = null;
  try {
    parsed = await parseTaskFromMessage(cleanMessage, assigneeName);
    console.log("[task] step 5 — parsed:", JSON.stringify(parsed));
  } catch (err) {
    console.error("[task] step 5 failed — parseTaskFromMessage error:", err);
  }

  if (!parsed || !parsed.hasTask || !parsed.taskText) {
    console.log("[task] no task found in message — sending clarification reply");
    await postThreadReply(
      channelId,
      threadTs,
      `Got it ${assignerName}! But I couldn't identify a clear task. Try: \`@TaskBot @${assigneeName} needs to [specific task description]\``
    );
    return;
  }

  const nextFollowupAt = calculateNextFollowupAt(0);
  console.log("[task] step 6 — inserting task into supabase, nextFollowupAt:", nextFollowupAt);

  const { data, error } = await supabase
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
    console.error("[task] step 6 failed — supabase insert error:", JSON.stringify(error));
    return;
  }

  console.log("[task] step 7 — task saved, id:", data?.id, "posting confirmation");

  await postThreadReply(
    channelId,
    threadTs,
    `✅ Got it! I've logged this task for *${assigneeName}*:\n> ${parsed.taskText}\n\nI'll follow up automatically until it's confirmed complete. ${assigneeName}, just reply *"done"* in this thread when you've finished.`
  );

  console.log("[task] done — task created successfully");
}

async function handleThreadReply(
  event: Record<string, unknown>,
  supabase: ReturnType<typeof createSupabaseAdmin>
) {
  const threadTs = event.thread_ts as string;
  const messageText = ((event.text as string) || "").toLowerCase().trim();
  const userId = event.user as string;

  console.log("[reply] looking up task for thread_ts:", threadTs, "userId:", userId);

  const { data: task } = await supabase
    .from("tasks")
    .select("*")
    .eq("thread_ts", threadTs)
    .eq("status", "active")
    .single();

  if (!task) {
    console.log("[reply] no active task found for this thread");
    return;
  }

  const isAssignee = userId === task.assigned_to_id;
  const isDoneMessage =
    /\b(done|completed|finished|complete|all done|sorted|did it|it's done|it is done)\b/.test(
      messageText
    );

  console.log("[reply] isAssignee:", isAssignee, "isDoneMessage:", isDoneMessage, "text:", messageText);

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

    console.log("[reply] task marked complete:", task.id);
  }
}
