import { NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import {
  verifySlackSignature,
  getSlackUserName,
  postThreadReply,
  getSlackClient,
  sendDirectMessage,
  getWorkspaceMembers,
  downloadSlackFile,
} from "@/lib/slack";
import { createSupabaseAdmin } from "@/lib/supabase";
import {
  parseTaskFromMessage,
  transcribeAudio,
  parseVoiceTranscription,
  parseThreadCommand,
  classifyCompletionIntent,
} from "@/lib/openai-messages";
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

  // ── TOP-LEVEL GUARDS (apply before anything else) ───────────────────────────

  // Only process events from the monitored channel
  if (event.channel !== monitoredChannelId) return;

  // Handle message deletions FIRST — deletion events may carry bot_id metadata
  // that would cause them to be dropped by the guard below.
  if (event.subtype === "message_deleted") {
    const deletedTs = (event.deleted_ts as string) ?? (event.previous_message as Record<string, unknown>)?.ts as string;
    const channelId = event.channel as string;
    if (deletedTs) {
      await handleMessageDeleted(deletedTs, channelId, supabase);
    }
    return;
  }

  // Ignore bot messages and automated system messages.
  // Check both bot_id (API bots) and app_id (Slack apps), and also check
  // if the sender user ID matches our own bot — some Slack configurations
  // omit bot_id on the bot's own messages.
  if (event.bot_id || event.app_id) {
    console.log("[slack] ignoring bot/app message");
    return;
  }
  const botUserId = await getBotUserId();
  const botEnvId = process.env.SLACK_BOT_USER_ID ?? "";
  const senderId = (event.user as string) ?? "";
  if (senderId && (senderId === botUserId || senderId === botEnvId)) {
    console.log("[slack] ignoring message from bot's own user ID");
    return;
  }

  // Allow file_share through — Slack sends voice notes and file uploads with
  // this subtype. We handle audio files below; non-audio file_share is ignored there.
  // All other subtypes (message_changed, thread_broadcast, slackbot_response, etc.)
  // are dropped here.
  if (event.subtype && event.subtype !== "file_share") {
    console.log("[slack] ignoring subtype:", event.subtype);
    return;
  }

  console.log("[slack] event:", event.type, "thread_ts:", event.thread_ts ?? "none", "user:", senderId);

  // ── CASE 0: Audio file uploaded (channel root OR inside a thread) ────────────
  if (
    event.type === "message" &&
    event.files &&
    Array.isArray(event.files) &&
    event.files.length > 0
  ) {
    const files = event.files as Array<Record<string, unknown>>;
    const audioFile = files.find(f => {
      const mimetype = (f.mimetype as string) ?? "";
      const filetype = (f.filetype as string) ?? "";
      return (
        mimetype.startsWith("audio/") ||
        filetype === "mp4" ||
        filetype === "webm" ||
        filetype === "ogg" ||
        filetype === "m4a" ||
        filetype === "mp3"
      );
    });

    if (audioFile) {
      if (event.thread_ts && event.thread_ts !== event.ts) {
        // Voice note inside an existing task thread → treat as a thread command
        console.log("[voice] audio in thread detected:", audioFile.name);
        await handleVoiceThreadCommand(event, audioFile, supabase, brandonUserId);
      } else {
        // Voice note at channel root → create a new task
        console.log("[voice] audio file detected:", audioFile.name);
        await handleVoiceMessage(event, audioFile, supabase, brandonUserId);
      }
      return;
    }
    // Non-audio file upload — ignore
    return;
  }

  // ── CASE 1: Bot @mentioned in channel root → create new task ─────────────────
  if (event.type === "app_mention" && !event.thread_ts) {
    console.log("[slack] → new task mention");
    await handleNewTaskMention(event, supabase, brandonUserId);
    return;
  }

  // ── CASE 2: Bot @mentioned inside a thread → thread command ──────────────────
  if (event.type === "app_mention" && event.thread_ts) {
    console.log("[slack] → bot mentioned in thread");
    await handleBotMentionInThread(event, supabase, brandonUserId);
    return;
  }

  // ── CASE 2.5: Brandon's plain management command in thread (no @bot mention) ──
  // Brandon can manage tasks without @mentioning the bot — e.g.
  // "assign this also to @Makoy", "cancel this task", "reassign to @Harry".
  // Route these to handleBotMentionInThread when they contain management keywords.
  if (
    event.type === "message" &&
    event.thread_ts &&
    event.thread_ts !== event.ts &&
    senderId === brandonUserId
  ) {
    const msgText = (event.text as string) ?? "";
    const hasManagementKeywords = /\b(assign|reassign|add|remove|cancel|reopen|restore|unassign)\b/i.test(msgText);
    if (hasManagementKeywords) {
      console.log("[slack] → Brandon management command (no bot mention)");
      await handleBotMentionInThread(event, supabase, brandonUserId);
      return;
    }
  }

  // ── CASE 3: Human reply in a task thread (bot NOT mentioned) ─────────────────
  // Only fires for genuine thread replies — NOT top-level channel messages.
  // thread_ts exists and differs from ts only on actual replies.
  if (event.type === "message" && event.thread_ts && event.thread_ts !== event.ts) {
    console.log("[slack] → thread reply");
    await handleThreadReply(event, supabase);
    return;
  }

  // Everything else (top-level channel messages, reactions, etc.) — ignore silently
}

// Save a bot-posted message ts so handleMessageDeleted can clean it up later.
async function saveBotMessageTs(
  supabase: ReturnType<typeof createSupabaseAdmin>,
  channelId: string,
  threadTs: string,
  messageTs: string | null
) {
  if (!messageTs) return;
  try {
    await supabase.from("bot_messages").insert({ channel_id: channelId, thread_ts: threadTs, message_ts: messageTs });
  } catch {
    // Non-critical — deletion cleanup falls back to conversations.replies
  }
}

// Format task text for Slack messages.
// Single task  → "*Task:* Buy yellow paper"
// Multi-line   → "*Task 1:* Buy yellow paper\n*Task 2:* Cook adobo"
function formatTaskBody(text: string): string {
  const lines = text
    .split(/\n|;/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length <= 1) return `*Task:* ${text.trim()}`;
  return lines.map((l, i) => `*Task ${i + 1}:* ${l}`).join("\n");
}

async function handleMessageDeleted(
  deletedTs: string,
  channelId: string,
  supabase: ReturnType<typeof createSupabaseAdmin>
) {
  // Search ALL statuses — we need to find the thread even if tasks are already
  // cancelled, so we can still clean up orphaned bot replies in the channel.
  const { data: byThread } = await supabase
    .from("tasks")
    .select("id, status, thread_ts, channel_id")
    .eq("thread_ts", deletedTs);

  const { data: byMessage } = await supabase
    .from("tasks")
    .select("id, status, thread_ts, channel_id")
    .eq("message_ts", deletedTs);

  const allTasks = [
    ...(byThread ?? []),
    ...(byMessage ?? []),
  ].filter((t, i, arr) => arr.findIndex((x) => x.id === t.id) === i);

  // Cancel any tasks that are not already closed
  const openTasks = allTasks.filter(
    (t) => t.status !== "cancelled" && t.status !== "escalated"
  );
  if (openTasks.length > 0) {
    const ids = openTasks.map((t) => t.id as string);
    await supabase
      .from("tasks")
      .update({ status: "cancelled", next_followup_at: null })
      .in("id", ids);
    console.log("[delete] cancelled", ids.length, "task(s) for deleted ts:", deletedTs);
  } else {
    console.log("[delete] no open tasks to cancel for ts:", deletedTs, "(", allTasks.length, "already closed)");
  }

  // Always clean up bot replies — even when no DB tasks were found, orphaned bot
  // messages may still be visible in the thread.
  const resolvedChannelId = channelId || (allTasks[0]?.channel_id as string);
  if (!resolvedChannelId) {
    console.log("[delete] no channel ID available, skipping bot message cleanup");
    return;
  }

  const slack = getSlackClient();

  // Primary path: use stored bot message timestamps from the bot_messages table.
  // These are saved whenever the bot posts, so deletion works even when the
  // Slack API can't return thread replies for a deleted audio/file root message.
  const { data: storedBotMessages } = await supabase
    .from("bot_messages")
    .select("message_ts")
    .eq("channel_id", resolvedChannelId)
    .eq("thread_ts", deletedTs);

  if (storedBotMessages && storedBotMessages.length > 0) {
    console.log("[delete] deleting", storedBotMessages.length, "stored bot message(s)");
    await Promise.all(
      storedBotMessages.map((row) =>
        slack.chat.delete({ channel: resolvedChannelId, ts: row.message_ts }).catch((err) => {
          console.error("[delete] failed to delete stored message ts:", row.message_ts, err?.data?.error);
        })
      )
    );
    // Clean up the stored references too
    await supabase.from("bot_messages").delete().eq("thread_ts", deletedTs).eq("channel_id", resolvedChannelId);
    return;
  }

  // Fallback: stored records not found — try conversations.replies.
  // This works for text messages (root remains as "deleted" placeholder) but
  // may fail for audio/file messages where Slack removes the thread anchor.
  try {
    const botUserId = await getBotUserId();
    const botEnvId = process.env.SLACK_BOT_USER_ID ?? "";

    const replies = await slack.conversations.replies({
      channel: resolvedChannelId,
      ts: deletedTs,
      limit: 200,
    });

    const botMessages = (replies.messages ?? []).filter((m) => {
      const isBot = m.user === botUserId || m.user === botEnvId || !!m.bot_id;
      const isRoot = m.ts === deletedTs;
      return isBot && !isRoot;
    });

    console.log("[delete] fallback: deleting", botMessages.length, "bot message(s) from thread");

    await Promise.all(
      botMessages.map((m) =>
        slack.chat.delete({ channel: resolvedChannelId, ts: m.ts! }).catch((err) => {
          console.error("[delete] failed to delete message ts:", m.ts, err?.data?.error);
        })
      )
    );
  } catch (err) {
    console.error("[delete] conversations.replies failed — bot messages in thread may need manual cleanup:", err);
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
  // Also filter via env var as a cold-start fallback (auth.test() may fail)
  const botEnvId = process.env.SLACK_BOT_USER_ID ?? "";

  const mentionPattern = /<@([A-Z0-9]+)>/g;
  const mentions = [...messageText.matchAll(mentionPattern)]
    .map(m => m[1])
    .filter(id => id !== brandonUserId && id !== botUserId && id !== botEnvId);

  const cleanMessage = messageText.replace(/<@[A-Z0-9]+>/g, "").trim();

  console.log("[task] step 2 — mentions:", mentions, "cleanMessage:", cleanMessage);

  if (mentions.length === 0 || !cleanMessage) {
    console.log("[task] no mentions or empty message — sending help reply");
    // If the message looks like a completion attempt ("done", "finished", etc.)
    // the user is likely saying "done" in the wrong place (main channel instead of thread).
    const mightBeCompletion = /^(done|finished|complete|completed|all done)[!.]?$/i.test(cleanMessage.trim());
    if (mightBeCompletion) {
      await postThreadReply(
        channelId,
        threadTs,
        `To mark a task as done, please reply *"done"* inside the task's Slack thread — not here in the main channel.\n\nFind the original task message and click *"Reply"* to open the thread, then type your reply there.`
      );
      return;
    }
    const hasTaskContent = cleanMessage.length > 10;
    await postThreadReply(
      channelId,
      threadTs,
      hasTaskContent
        ? "The assignee is not clear to me — please @mention the person directly in this channel so I can create the task."
        : "Hey! To assign a task, mention me and tag the person: `@Task Bot @teammate task description here`"
    );
    return;
  }

  console.log("[task] step 3 — mentions:", mentions, "senderId:", senderId);

  const results = await Promise.all([
    getSlackUserName(senderId),
    ...mentions.map(id => getSlackUserName(id)),
  ]).catch(err => {
    console.error("[task] step 4 failed — getSlackUserName error:", err);
    return null;
  });

  if (!results) return;

  const assignerName = results[0];
  const assignees = mentions.map((id, i) => ({ id, name: results[i + 1] }));
  const primaryAssignee = assignees[0];
  const allAssigneeNames = assignees.map(a => a.name).join(" and ");

  console.log("[task] step 4 — assignees:", allAssigneeNames, "assignerName:", assignerName);

  let parsed: { taskText: string; hasTask: boolean; textMentionedNames: string[] } | null = null;
  try {
    parsed = await parseTaskFromMessage(cleanMessage, allAssigneeNames);
    console.log("[task] step 5 — parsed:", JSON.stringify(parsed));
  } catch (err) {
    console.error("[task] step 5 failed — parseTaskFromMessage error:", err);
  }

  if (!parsed || !parsed.hasTask || !parsed.taskText) {
    console.log("[task] no task found in message — sending clarification reply");
    await postThreadReply(
      channelId,
      threadTs,
      `Got it ${assignerName}! But I couldn't identify a clear task. Try: \`@Task Bot @${primaryAssignee.name} needs to [specific task description]\``
    );
    return;
  }

  // Check whether any names written in plain text (not @mentioned) are unknown to this workspace.
  // e.g. "@TaskBot assign to @Harry and Paula" where Paula is not in the channel.
  if (parsed.textMentionedNames.length > 0) {
    const teamMembers = await getWorkspaceMembers();
    const mentionedIdSet = new Set(mentions);
    const unknownNames = parsed.textMentionedNames.filter(name => {
      const match = teamMembers.find(m =>
        m.name.toLowerCase().includes(name.toLowerCase()) ||
        name.toLowerCase().includes(m.name.split(" ")[0].toLowerCase())
      );
      // Known member already @mentioned → fine. Known member not @mentioned → skip silently.
      // Unknown to the workspace → flag it.
      if (match) return false;
      // Also skip if this name is just part of the @mentioned user's own name
      if (assignees.some(a => a.name.toLowerCase().includes(name.toLowerCase()))) return false;
      return true;
    });

    if (unknownNames.length > 0) {
      const unknownStr = unknownNames.map(n => `*${n}*`).join(", ");
      const alreadyAssigned = assignees.map(a => `<@${a.id}>`).join(", ");
      const clarifyTs = await postThreadReply(
        channelId,
        threadTs,
        `⚠️ ${unknownStr} ${unknownNames.length === 1 ? "doesn't seem to be" : "don't seem to be"} in this channel.\n\n` +
        `Is this task only for ${alreadyAssigned}? Or did you mean someone else?\n\n` +
        `Please @mention the correct user(s) below so I can create the task.`
      );
      await saveBotMessageTs(supabase, channelId, threadTs, clarifyTs);
      console.log("[task] paused — unknown assignee name(s):", unknownNames.join(", "));
      return;
    }
  }

  // Idempotency guard — Slack retries events on network errors; skip if already inserted
  const { count: existingCount } = await supabase
    .from("tasks")
    .select("id", { count: "exact", head: true })
    .eq("message_ts", messageTs);
  if (existingCount && existingCount > 0) {
    console.log("[task] dedup — task already exists for message_ts:", messageTs);
    return;
  }

  const nextFollowupAt = calculateNextFollowupAt(0, new Date(), process.env.TEAM_TIMEZONE ?? "America/New_York");
  console.log("[task] step 6 — inserting", assignees.length, "task row(s), nextFollowupAt:", nextFollowupAt);

  // One row per assignee so each person's completion is tracked independently.
  const taskInserts = assignees.map(assignee => ({
    task_text: parsed.taskText,
    raw_message: messageText,
    assigned_to_id: assignee.id,
    assigned_to_name: assignee.name,
    assignee_ids: [assignee.id],
    assignee_names: [assignee.name],
    assigned_by_id: senderId,
    assigned_by_name: assignerName,
    channel_id: channelId,
    message_ts: messageTs,
    thread_ts: threadTs,
    status: "active",
    followup_count: 0,
    max_followups: 5,
    next_followup_at: nextFollowupAt?.toISOString() ?? null,
    assignee_timezone: process.env.TEAM_TIMEZONE ?? "America/New_York",
  }));

  const { error } = await supabase.from("tasks").insert(taskInserts);

  if (error) {
    console.error("[task] step 6 failed — supabase insert error:", JSON.stringify(error));
    return;
  }

  console.log("[task] step 7 — tasks saved for", assignees.length, "assignee(s), posting confirmation");

  const allMentions = assignees.map(a => `<@${a.id}>`).join(", ");

  const confirmTs = await postThreadReply(
    channelId,
    threadTs,
    `✅ *Task assigned*\n\n*Assigned to:* ${allMentions}\n\n` +
      formatTaskBody(parsed.taskText) +
      `\n\n${allMentions} — please reply *"done"* in this thread when the task is complete. Use this thread for any questions.`
  );
  await saveBotMessageTs(supabase, channelId, threadTs, confirmTs);

  console.log("[task] done — task created successfully");
}

async function handleThreadReply(
  event: Record<string, unknown>,
  supabase: ReturnType<typeof createSupabaseAdmin>
) {
  const threadTs = event.thread_ts as string;
  const rawText = (event.text as string) || "";
  const messageText = rawText.toLowerCase().trim();
  const userId = event.user as string;

  // When a message @mentions the bot, Slack fires BOTH an app_mention event
  // AND a message event. handleBotMentionInThread handles the app_mention, so
  // we skip here to avoid a double reply.
  const botUserId2 = await getBotUserId();
  const botEnvId2 = process.env.SLACK_BOT_USER_ID ?? "";
  if (
    (botUserId2 && rawText.includes(`<@${botUserId2}>`)) ||
    (botEnvId2 && rawText.includes(`<@${botEnvId2}>`))
  ) {
    console.log("[reply] message mentions bot — skipping (handled by handleBotMentionInThread)");
    return;
  }

  console.log("[reply] looking up task for thread_ts:", threadTs, "userId:", userId);

  // ── CHECK: Is this a reply to a pending voice task (Brandon clarifying assignee)? ──
  const { data: pendingVoice } = await supabase
    .from("pending_voice_tasks")
    .select("*")
    .eq("thread_ts", threadTs)
    .eq("resolved", false)
    .maybeSingle();

  if (pendingVoice && userId === process.env.SLACK_BRANDON_USER_ID) {
    const rawReplyText = (event.text as string) ?? "";
    const botIdForFilter = cachedBotUserId || (process.env.SLACK_BOT_USER_ID ?? "");
    const replyMentions = [...rawReplyText.matchAll(/<@([A-Z0-9]+)>/g)]
      .map(m => m[1])
      .filter(id => id !== process.env.SLACK_BRANDON_USER_ID && id !== botIdForFilter);

    // Only resolve the pending task if the message is primarily an assignment
    // (short text, essentially just @mentions). If Brandon is writing a full
    // sentence or having a conversation in this thread, don't treat it as
    // task assignment — he might just be chatting.
    const nonMentionText = rawReplyText.replace(/<@[A-Z0-9]+>/g, "").trim();
    const isAssignmentMessage = replyMentions.length > 0 && nonMentionText.length <= 30;

    if (isAssignmentMessage) {
      const teamMembers = await getWorkspaceMembers();
      const assignerName = await getSlackUserName(userId);
      const nextFollowupAt = calculateNextFollowupAt(
        0,
        new Date(),
        process.env.TEAM_TIMEZONE ?? "America/New_York"
      );

      const matchedMembers = replyMentions.map(id => {
        const member = teamMembers.find(m => m.id === id);
        return member ?? { id, name: id };
      });

      const taskInserts = matchedMembers.map(member => ({
        task_text: pendingVoice.task_text,
        raw_message: pendingVoice.transcription,
        voice_transcription: pendingVoice.transcription,
        assigned_to_id: member.id,
        assigned_to_name: member.name,
        assignee_ids: [member.id],
        assignee_names: [member.name],
        assigned_by_id: pendingVoice.created_by_id,
        assigned_by_name: pendingVoice.created_by_name,
        channel_id: pendingVoice.channel_id,
        message_ts: pendingVoice.message_ts,
        thread_ts: pendingVoice.thread_ts,
        status: "active",
        followup_count: 0,
        max_followups: 5,
        next_followup_at: nextFollowupAt?.toISOString() ?? null,
        assignee_timezone: process.env.TEAM_TIMEZONE ?? "America/New_York",
      }));

      await supabase.from("tasks").insert(taskInserts);

      await supabase
        .from("pending_voice_tasks")
        .update({ resolved: true })
        .eq("id", pendingVoice.id);

      const assigneeMentions = matchedMembers.map(m => `<@${m.id}>`).join(", ");

      await postThreadReply(
        pendingVoice.channel_id,
        pendingVoice.thread_ts,
        `✅ *Task assigned*\n\n*Assigned to:* ${assigneeMentions}\n\n` +
          formatTaskBody(pendingVoice.task_text) +
          `\n\n${assigneeMentions} — please reply *"done"* in this thread when the task is complete. Use this thread for any questions.`
      );

      console.log("[voice] pending task resolved, assigned to:", matchedMembers.map(m => m.name).join(", "));
      return;
    }
  }

  // Fetch all tasks in this thread
  const { data: allThreadTasks } = await supabase
    .from("tasks")
    .select("*")
    .eq("thread_ts", threadTs)
    .order("created_at", { ascending: true });

  if (!allThreadTasks || allThreadTasks.length === 0) {
    console.log("[reply] no task found for this thread");
    return;
  }

  // Use the most recent task as the primary task for metadata/logging
  const task = allThreadTasks[allThreadTasks.length - 1];

  // Check across ALL thread rows so multi-assignee tasks work correctly
  const isAssignee = allThreadTasks.some(
    t => (t.assigned_to_id === userId || t.assignee_ids?.includes(userId)) &&
         (t.status === "active" || t.status === "revision_requested")
  );
  const isOpen = allThreadTasks.some(t => t.status === "active" || t.status === "revision_requested");

  // Closed tasks: just log the reply for dashboard visibility
  if (!isOpen) {
    if (rawText.length > 0) {
      const authorName = isAssignee ? task.assigned_to_name : await getSlackUserName(userId);
      await supabase.from("task_comments").insert({
        task_id: task.id,
        author_type: isAssignee ? "assignee" : "system",
        author_name: authorName,
        content: isAssignee ? rawText : `${authorName} (in thread): ${rawText}`,
        sent_to_slack: false,
      });
      console.log(`[reply] logged reply on ${task.status} task for dashboard visibility`);
    }
    return;
  }

  // Handle "Task N done" replies for multi-task threads
  const taskNumberMatch = rawText.match(/task\s*(\d+)\s*(is\s*)?(done|complete|finished)/i);
  if (taskNumberMatch && isAssignee) {
    const taskIndex = parseInt(taskNumberMatch[1]) - 1;
    const myTasks = allThreadTasks.filter(
      (t) => (t.assignee_ids?.includes(userId) || t.assigned_to_id === userId) &&
             t.status !== "cancelled" && t.status !== "escalated"
    );
    const targetTask = myTasks[taskIndex];
    if (!targetTask) {
      await postThreadReply(task.channel_id, task.thread_ts,
        myTasks.length === 0
          ? "You don't have any tasks assigned to you in this thread."
          : `There ${myTasks.length === 1 ? "is" : "are"} only *${myTasks.length} task${myTasks.length === 1 ? "" : "s"}* assigned to you in this thread. Please double-check.`
      );
      return;
    }
    if (targetTask.status === "completed") {
      await postThreadReply(task.channel_id, task.thread_ts, `✅ *Task ${taskIndex + 1}* is already marked as done:\n> ${targetTask.task_text}`);
      return;
    }
    if (targetTask.status === "active" || targetTask.status === "revision_requested") {
      await supabase.from("tasks").update({ status: "completed", completed_at: new Date().toISOString(), next_followup_at: null }).eq("id", targetTask.id);

      const remainingAfterN = myTasks.filter(
        t => t.id !== targetTask.id && (t.status === "active" || t.status === "revision_requested")
      );
      let taskNDoneMsg = `🎉 Got it ${targetTask.assigned_to_name}! *Task ${taskIndex + 1}* marked as done:\n> ${targetTask.task_text}`;
      if (remainingAfterN.length > 0) {
        const remainingLines = remainingAfterN.map(t => {
          const tNum = myTasks.findIndex(x => x.id === t.id) + 1;
          return `*Task ${tNum}:* ${t.task_text}`;
        }).join("\n");
        const donePrompt = remainingAfterN.length === 1
          ? `Reply *"Task ${myTasks.findIndex(x => x.id === remainingAfterN[0].id) + 1} done"* when it's complete.`
          : `Reply *"Task ${myTasks.findIndex(x => x.id === remainingAfterN[0].id) + 1} done"*, *"Task ${myTasks.findIndex(x => x.id === remainingAfterN[remainingAfterN.length - 1].id) + 1} done"*, etc. when each is complete.`;
        taskNDoneMsg += `\n\n📋 *Still in progress:*\n${remainingLines}\n\n${donePrompt}`;
      } else {
        taskNDoneMsg += `\n\nAll tasks complete! Nice one — I've stopped the follow-ups.`;
      }

      await postThreadReply(targetTask.channel_id, targetTask.thread_ts, taskNDoneMsg);
      await sendDirectMessage(
        process.env.SLACK_BRANDON_USER_ID!,
        `✅ *Task Completed*\n\n*Assignee:* ${targetTask.assigned_to_name}\n*Task:* ${targetTask.task_text}`
      );
      return;
    }
  }

  // Only assignees can mark a task done; non-assignees (Brandon, others) are always just conversation
  const mightBeDone =
    isAssignee &&
    /\b(done|completed|finished|complete|all done|sorted|submitted|sent|delivered|wrapped up|good to go|ready|all set|handled|accomplished)\b/.test(
      messageText
    );

  console.log("[reply] isAssignee:", isAssignee, "mightBeDone:", mightBeDone, "text:", messageText);

  const isDoneMessage = mightBeDone
    ? await classifyCompletionIntent(rawText, task.task_text)
    : false;

  if (isDoneMessage) {
    // Check how many active tasks this user has in this thread
    const myActiveTasks = allThreadTasks.filter(
      (t) => (t.assignee_ids?.includes(userId) || t.assigned_to_id === userId) &&
              (t.status === "active" || t.status === "revision_requested")
    );

    if (myActiveTasks.length > 1) {
      // Multiple active tasks — ask which one is done
      const taskList = myActiveTasks.map((t, i) => `*Task ${i + 1}:* ${t.task_text}`).join("\n");
      await postThreadReply(
        task.channel_id,
        task.thread_ts,
        `Great work <@${userId}>! Which task are you marking as done?\n\n${taskList}\n\nReply with *"Task 1 done"*, *"Task 2 done"*, etc.`
      );
      return;
    }

    // Single active task — mark it done
    const taskToComplete = myActiveTasks[0] ?? task;
    await supabase
      .from("tasks")
      .update({
        status: "completed",
        completed_at: new Date().toISOString(),
        next_followup_at: null,
      })
      .eq("id", taskToComplete.id);

    // Check if this user has other active tasks remaining in the thread
    const allMyTasks = allThreadTasks.filter(
      t => t.assignee_ids?.includes(userId) || t.assigned_to_id === userId
    );
    const remainingActiveTasks = allMyTasks.filter(
      t => t.id !== taskToComplete.id && (t.status === "active" || t.status === "revision_requested")
    );
    const completedTaskNumber = allMyTasks.findIndex(t => t.id === taskToComplete.id) + 1;
    const showTaskNumber = allMyTasks.length > 1;

    let completionMsg = `🎉 Great work ${taskToComplete.assigned_to_name}! ${showTaskNumber ? `*Task ${completedTaskNumber}* marked` : `Task marked`} as *done*:\n> ${taskToComplete.task_text}`;
    if (remainingActiveTasks.length > 0) {
      const remainingLines = remainingActiveTasks.map(t => {
        const taskNum = allMyTasks.findIndex(x => x.id === t.id) + 1;
        return `*Task ${taskNum}:* ${t.task_text}`;
      }).join("\n");
      const donePrompt2 = remainingActiveTasks.length === 1
        ? `Reply *"Task ${allMyTasks.findIndex(x => x.id === remainingActiveTasks[0].id) + 1} done"* when it's complete.`
        : `Reply *"Task ${allMyTasks.findIndex(x => x.id === remainingActiveTasks[0].id) + 1} done"*, *"Task ${allMyTasks.findIndex(x => x.id === remainingActiveTasks[remainingActiveTasks.length - 1].id) + 1} done"*, etc. when each is complete.`;
      completionMsg += `\n\n📋 *Still in progress:*\n${remainingLines}\n\n${donePrompt2}`;
    } else {
      completionMsg += `\n\nNice one — I've stopped the follow-ups.`;
    }

    await postThreadReply(
      taskToComplete.channel_id,
      taskToComplete.thread_ts,
      completionMsg
    );

    await supabase.from("task_comments").insert([
      {
        task_id: taskToComplete.id,
        author_type: "assignee",
        author_name: taskToComplete.assigned_to_name,
        content: rawText,
        sent_to_slack: false,
      },
      {
        task_id: taskToComplete.id,
        author_type: "system",
        author_name: "System",
        content: `${taskToComplete.assigned_to_name} marked this task as done.`,
        sent_to_slack: true,
      },
    ]);

    const brandonUserId = process.env.SLACK_BRANDON_USER_ID!;
    await sendDirectMessage(
      brandonUserId,
      `✅ *Task Completed*\n\n*Assignee:* ${taskToComplete.assigned_to_name}\n*Task:* ${taskToComplete.task_text}\n\nThis task has been marked as done.`
    );

    console.log("[reply] task marked completed:", taskToComplete.id);
    return;
  }

  // Non-assignee saying "done" — gently redirect them
  const nonAssigneeMightBeDone =
    !isAssignee &&
    /\b(done|completed|finished|complete)\b/i.test(rawText);
  if (nonAssigneeMightBeDone) {
    const allActiveAssigneeNames = [...new Set(
      allThreadTasks
        .filter(t => t.status === "active" || t.status === "revision_requested")
        .map(t => t.assigned_to_name as string)
    )];
    await postThreadReply(
      task.channel_id,
      task.thread_ts,
      `Hey <@${userId}>, you're not assigned to this task — only ${allActiveAssigneeNames.map(n => `*${n}*`).join(" and ")} can mark it as done. You might be in the wrong thread!`
    );
    return;
  }

  // Log every other human reply for full thread visibility on the dashboard
  if (rawText.length > 0) {
    const senderTask = allThreadTasks.find(t => t.assigned_to_id === userId || t.assignee_ids?.includes(userId));
    const authorName = isAssignee ? (senderTask?.assigned_to_name ?? task.assigned_to_name) : await getSlackUserName(userId);
    await supabase.from("task_comments").insert({
      task_id: task.id,
      author_type: isAssignee ? "assignee" : "system",
      author_name: authorName,
      content: isAssignee ? rawText : `${authorName} (in thread): ${rawText}`,
      sent_to_slack: false,
    });
    console.log("[reply] thread reply logged, follow-ups continue");
  }
}

async function handleBotMentionInThread(
  event: Record<string, unknown>,
  supabase: ReturnType<typeof createSupabaseAdmin>,
  brandonUserId: string
) {
  const threadTs = event.thread_ts as string;
  const channelId = event.channel as string;
  const rawText = (event.text as string) ?? "";
  const senderId = event.user as string;
  const botUserId = await getBotUserId();

  // Fetch ALL tasks in this thread (any status) to detect if this is a task thread.
  // We include cancelled/completed so that a thread where tasks were previously
  // cancelled still routes to thread-command mode instead of new-task mode.
  const { data: threadTasks } = await supabase
    .from("tasks")
    .select("*")
    .eq("thread_ts", threadTs)
    .order("created_at", { ascending: true });

  // No tasks at all in this thread — fall through to new task creation
  if (!threadTasks || threadTasks.length === 0) {
    console.log("[thread-cmd] no existing tasks, delegating to new task handler");
    await handleNewTaskMention(event, supabase, brandonUserId);
    return;
  }

  // Active tasks for command context (reassign, add, etc.) — completed tasks are excluded
  // so they are never re-cancelled by remove/reassign/cancel operations.
  const activeThreadTasks = threadTasks.filter(
    (t) => t.status === "active" || t.status === "revision_requested"
  );

  const teamMembers = await getWorkspaceMembers();
  // Use active tasks for context; fall back to most recent task if all are cancelled
  const contextTasks = activeThreadTasks.length > 0 ? activeThreadTasks : threadTasks;
  const existingTaskText = contextTasks[contextTasks.length - 1].task_text as string;
  const existingAssigneeNames: string[] = [
    ...new Set(contextTasks.flatMap((t) => (t.assignee_names?.length ? t.assignee_names : [t.assigned_to_name]) as string[])),
  ];

  const botEnvId = process.env.SLACK_BOT_USER_ID ?? "";

  // Extract @mentions from the command (excluding bot and brandon)
  const mentionedIds = [...rawText.matchAll(/<@([A-Z0-9]+)>/g)]
    .map((m) => m[1])
    .filter((id) => id !== botUserId && id !== botEnvId && id !== brandonUserId);

  // Build a human-readable version of the message for GPT
  const humanText = rawText.replace(/<@([A-Z0-9]+)>/g, (_, id) => {
    const m = teamMembers.find((t) => t.id === id);
    return m ? `@${m.name}` : `<@${id}>`;
  });

  // Strip all @mentions to see what the person actually said
  const textContent = rawText.replace(/<@[A-Z0-9]+>/g, "").replace(/\s+/g, " ").trim();

  // Casual acknowledgments — person is just saying "got it", "thanks", etc.
  // Stay completely silent. No need to respond.
  // Strip @mentions and bare team member names from the text to reveal the core message
  const strippedForAck = rawText
    .replace(/<@[A-Z0-9]+>/g, "")
    .replace(new RegExp(`\\b(${teamMembers.map(m => m.name.split(" ")[0]).join("|")})\\b`, "gi"), "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[.,!?]+$/, "");

  const ACK_PHRASES = /^(got it|thanks|thank you|ok|okay|noted|understood|will do|on it|sure|sounds good|perfect|great|alright|roger|copy that|no problem|np|cool|nice|awesome|received|ack|k|kk|yep|yup|yes|got|noted thanks|and|thanks and|got it thanks|got it thank you|and thank you|and thanks)$/i;

  const isAcknowledgment =
    strippedForAck.length === 0 ||
    ACK_PHRASES.test(strippedForAck) ||
    /^(👍|🙏|✅|👌)$/.test(strippedForAck);

  if (isAcknowledgment) {
    console.log("[thread-cmd] casual acknowledgment from", senderId, "— staying silent");
    return;
  }

  // Task summary request — answer directly without calling GPT
  // Matches: "summary", "any summary", "summarize", "give me summary", "summary of this thread", etc.
  const isSummaryRequest =
    /\b(what (are|is)|list|show|status of).*task|task.*(list|status|what)/i.test(textContent) ||
    /\bsummar(y|ize|ies)\b/i.test(textContent);
  if (isSummaryRequest) {
    // Only the manager (Brandon) can request summaries — others are silently ignored
    const brandonId = process.env.SLACK_BRANDON_USER_ID ?? "";
    if (senderId !== brandonId) {
      console.log("[thread-cmd] summary request from non-manager — ignoring silently");
      return;
    }

    const { data: summaryTasks } = await supabase
      .from("tasks")
      .select("*")
      .eq("thread_ts", threadTs)
      .order("created_at", { ascending: true });

    const tasks = summaryTasks ?? [];
    if (tasks.length === 0) {
      await postThreadReply(channelId, threadTs, "No tasks found in this thread.");
      return;
    }

    // Group rows by task_text so the same task assigned to multiple people shows as one entry
    const groupMap = new Map<string, typeof tasks>();
    for (const t of tasks) {
      const key = t.task_text as string;
      if (!groupMap.has(key)) groupMap.set(key, []);
      groupMap.get(key)!.push(t);
    }

    const taskCount = groupMap.size;
    const lines = [...groupMap.entries()].map(([taskText, group], i) => {
      const activeRows    = group.filter(t => t.status === "active" || t.status === "revision_requested");
      const completedRows = group.filter(t => t.status === "completed");
      const cancelledRows = group.filter(t => t.status === "cancelled" || t.status === "escalated");

      const allDone      = group.every(t => t.status === "completed");
      const noneActive   = activeRows.length === 0 && completedRows.length === 0;
      const icon = allDone ? "✅" : noneActive ? "🗑️" : "🔵";
      const label = taskCount === 1 ? `*Task:*` : `*Task ${i + 1}:*`;

      const parts: string[] = [`${icon} ${label} ${taskText}`];

      // Active (in-progress) assignees
      if (activeRows.length > 0) {
        const names = activeRows.map(t => `<@${t.assigned_to_id}>`).join(", ");
        parts.push(`   ⏳ *In progress:* ${names}`);
      }

      // Completed assignees
      if (completedRows.length > 0) {
        const names = completedRows.map(t => `<@${t.assigned_to_id}>`).join(", ");
        parts.push(`   ✅ *Completed by:* ${names}`);
      }

      // History: cancelled rows alongside active/completed = reassignment happened
      if (cancelledRows.length > 0 && (activeRows.length > 0 || completedRows.length > 0)) {
        const from = cancelledRows.map(t => t.assigned_to_name as string).join(", ");
        const to   = [...activeRows, ...completedRows].map(t => t.assigned_to_name as string).join(", ");
        parts.push(`   🔄 *History:* Originally assigned to ${from} → Reassigned to ${to}`);
      } else if (noneActive && cancelledRows.length > 0) {
        const who = cancelledRows.map(t => `<@${t.assigned_to_id}>`).join(", ");
        parts.push(`   🗑️ *Cancelled* — was assigned to ${who}`);
      }

      return parts.join("\n");
    });

    await postThreadReply(channelId, threadTs, `📋 *Task Summary*\n\n${lines.join("\n\n")}`);
    return;
  }

  // Handle "task N done/complete/finished" directed at bot — intercept before
  // parseThreadCommand so GPT doesn't classify it as "unknown" and show help menu.
  const botTaskDoneMatch = textContent.match(/task\s*(\d+)\s*(is\s*)?(done|complete|finished)/i);
  if (botTaskDoneMatch) {
    const taskIndex = parseInt(botTaskDoneMatch[1]) - 1;
    const senderTasks = threadTasks.filter(
      t => (t.assigned_to_id === senderId || t.assignee_ids?.includes(senderId)) &&
           t.status !== "cancelled" && t.status !== "escalated"
    );
    const targetTask = senderTasks[taskIndex];
    if (!targetTask) {
      await postThreadReply(channelId, threadTs,
        senderTasks.length === 0
          ? "You don't have any tasks assigned to you in this thread."
          : `There ${senderTasks.length === 1 ? "is" : "are"} only *${senderTasks.length} task${senderTasks.length === 1 ? "" : "s"}* assigned to you in this thread. Please double-check.`
      );
      return;
    }
    if (targetTask.status === "completed") {
      await postThreadReply(channelId, threadTs, `✅ *Task ${taskIndex + 1}* is already marked as done:\n> ${targetTask.task_text}`);
      return;
    }
    if (targetTask.status === "active" || targetTask.status === "revision_requested") {
      await supabase.from("tasks").update({
        status: "completed",
        completed_at: new Date().toISOString(),
        next_followup_at: null,
      }).eq("id", targetTask.id);

      const remainingActive = senderTasks.filter(
        t => t.id !== targetTask.id && (t.status === "active" || t.status === "revision_requested")
      );
      let replyMsg = `🎉 Got it! *Task ${taskIndex + 1}* marked as done:\n> ${targetTask.task_text}`;
      if (remainingActive.length > 0) {
        const remainingLines = remainingActive.map(t => {
          const tNum = senderTasks.findIndex(x => x.id === t.id) + 1;
          return `*Task ${tNum}:* ${t.task_text}`;
        }).join("\n");
        const donePrompt3 = remainingActive.length === 1
          ? `Reply *"Task ${senderTasks.findIndex(x => x.id === remainingActive[0].id) + 1} done"* when it's complete.`
          : `Reply *"Task ${senderTasks.findIndex(x => x.id === remainingActive[0].id) + 1} done"*, *"Task ${senderTasks.findIndex(x => x.id === remainingActive[remainingActive.length - 1].id) + 1} done"*, etc. when each is complete.`;
        replyMsg += `\n\n📋 *Still in progress:*\n${remainingLines}\n\n${donePrompt3}`;
      } else {
        replyMsg += `\n\nAll tasks complete! Nice one — I've stopped the follow-ups.`;
      }

      await postThreadReply(channelId, threadTs, replyMsg);
      await sendDirectMessage(
        process.env.SLACK_BRANDON_USER_ID!,
        `✅ *Task Completed*\n\n*Assignee:* ${targetTask.assigned_to_name}\n*Task:* ${targetTask.task_text}`
      );
      return;
    }
  }

  // No active tasks left but the sender was an assignee saying "done".
  // This happens when co-assignees share a single task row and one person already
  // completed it — the second person's "done" would otherwise hit GPT and get
  // misclassified as cancel_task. Respond gracefully and skip GPT entirely.
  if (activeThreadTasks.length === 0) {
    const senderWasAssignee = threadTasks.some(
      t => t.assigned_to_id === senderId || (t.assignee_ids as string[] | null)?.includes(senderId)
    );
    if (senderWasAssignee && /\b(done|completed|finished|complete|all done)\b/i.test(textContent)) {
      await postThreadReply(channelId, threadTs, `✅ All tasks in this thread are already marked as complete — nothing left to do. Nice work!`);
      return;
    }
  }

  // Intercept "restore/reopen task N" by position number so we use the thread's
  // task ordering rather than GPT's closedTaskTexts list ordering.
  const restoreByNumberMatch = textContent.match(/\b(restore|reopen|reactivate|uncancel|bring\s+back)\s+task\s*(\d+)\b/i);
  if (restoreByNumberMatch) {
    const taskIndex = parseInt(restoreByNumberMatch[2]) - 1;
    const allUniqueTexts = [...new Set(threadTasks.map(t => t.task_text as string))];
    if (taskIndex < 0 || taskIndex >= allUniqueTexts.length) {
      await postThreadReply(channelId, threadTs,
        `There ${allUniqueTexts.length === 1 ? "is" : "are"} only *${allUniqueTexts.length} task${allUniqueTexts.length === 1 ? "" : "s"}* in this thread. Please double-check.`
      );
      return;
    }
    const restoreTargetText = allUniqueTexts[taskIndex];
    const tasksToRestoreByNum = threadTasks.filter(t =>
      (t.task_text as string) === restoreTargetText &&
      (t.status === "cancelled" || t.status === "completed")
    );
    if (tasksToRestoreByNum.length === 0) {
      await postThreadReply(channelId, threadTs, `Task ${taskIndex + 1} is already active — nothing to restore.`);
      return;
    }
    const nextFollowupAtRestore = calculateNextFollowupAt(0, new Date(), process.env.TEAM_TIMEZONE ?? "America/New_York");
    await supabase.from("tasks").update({
      status: "active",
      completed_at: null,
      next_followup_at: nextFollowupAtRestore?.toISOString() ?? null,
      followup_count: 0,
    }).in("id", tasksToRestoreByNum.map(t => t.id as string));
    const restoreMentions = [...new Set(tasksToRestoreByNum.map(t => t.assigned_to_id as string))]
      .map(id => `<@${id}>`).join(", ");
    await postThreadReply(channelId, threadTs,
      `🔁 Task ${taskIndex + 1} reopened and follow-ups restarted.\n\n*Assigned to:* ${restoreMentions}\n\n${formatTaskBody(restoreTargetText)}\n\n${restoreMentions} — please reply *"done"* when complete.`
    );
    console.log("[thread-cmd] restore-by-number: task", taskIndex + 1, "—", restoreTargetText.slice(0, 60));
    return;
  }

  // Intercept "remove [person] from task N" by position number so only that specific
  // task row is cancelled, not all of the person's tasks in this thread.
  const removeFromTaskNumMatch = textContent.match(/\bfrom\s+task\s*(\d+)\b/i);
  if (removeFromTaskNumMatch && /\b(remove|unassign)\b/i.test(textContent) && mentionedIds.length > 0) {
    const taskIndex = parseInt(removeFromTaskNumMatch[1]) - 1;
    const allUniqueActiveTexts = [...new Set(activeThreadTasks.map(t => t.task_text as string))];
    if (taskIndex < 0 || taskIndex >= allUniqueActiveTexts.length) {
      await postThreadReply(channelId, threadTs,
        `There ${allUniqueActiveTexts.length === 1 ? "is" : "are"} only *${allUniqueActiveTexts.length} active task${allUniqueActiveTexts.length === 1 ? "" : "s"}* in this thread. Please double-check.`
      );
      return;
    }
    const removeTargetText = allUniqueActiveTexts[taskIndex];
    const tasksToCancel = activeThreadTasks.filter(t =>
      (t.task_text as string) === removeTargetText &&
      mentionedIds.includes(t.assigned_to_id as string)
    );
    if (tasksToCancel.length === 0) {
      const notAssigned = mentionedIds.map(id => `<@${id}>`).join(", ");
      await postThreadReply(channelId, threadTs,
        `${notAssigned} ${mentionedIds.length === 1 ? "is" : "are"} not assigned to Task ${taskIndex + 1}.`
      );
      return;
    }
    await supabase.from("tasks").update({ status: "cancelled", next_followup_at: null })
      .in("id", tasksToCancel.map(t => t.id as string));
    const removedMentions = [...new Set(tasksToCancel.map(t => t.assigned_to_id as string))]
      .map(id => `<@${id}>`).join(", ");
    const stillActive = activeThreadTasks.filter(t => !tasksToCancel.some(c => c.id === t.id));
    const stillActiveMentions = [...new Set(stillActive.map(t => t.assigned_to_id as string))]
      .map(id => `<@${id}>`).join(", ");
    await postThreadReply(channelId, threadTs,
      `🗑️ Removed ${removedMentions} from Task ${taskIndex + 1}.\n\n` +
      (stillActive.length > 0
        ? `The remaining task${stillActive.length === 1 ? "" : "s"} are still active with ${stillActiveMentions}.`
        : "No more active tasks in this thread.")
    );
    console.log("[thread-cmd] remove-from-task-num: task", taskIndex + 1, "—", tasksToCancel.length, "row(s) cancelled");
    return;
  }

  // ── COMPLETION VIA BOT MENTION ───────────────────────────────────────────
  // Assignee said "@taskbot done" — handle completion before GPT command parsing.
  // This covers the case where someone @mentions the bot while saying "done",
  // which otherwise falls into parseThreadCommand (a management-command parser)
  // and gets classified as "unknown" or misclassified.
  const senderActiveTasks = activeThreadTasks.filter(
    t => t.assigned_to_id === senderId || (t.assignee_ids as string[] | null)?.includes(senderId)
  );
  if (
    senderActiveTasks.length > 0 &&
    /\b(done|completed|finished|complete|all done|sorted|submitted|sent|delivered|wrapped up|good to go|ready|all set|handled|accomplished)\b/i.test(textContent)
  ) {
    const isDoneViaBotMention = await classifyCompletionIntent(rawText, senderActiveTasks[0].task_text as string);
    if (isDoneViaBotMention) {
      if (senderActiveTasks.length > 1) {
        const taskList = senderActiveTasks.map((t, i) => `*Task ${i + 1}:* ${t.task_text}`).join("\n");
        await postThreadReply(channelId, threadTs,
          `Great work <@${senderId}>! Which task are you marking as done?\n\n${taskList}\n\nReply with *"Task 1 done"*, *"Task 2 done"*, etc.`
        );
        return;
      }
      const taskToComplete = senderActiveTasks[0];
      await supabase.from("tasks").update({
        status: "completed",
        completed_at: new Date().toISOString(),
        next_followup_at: null,
      }).eq("id", taskToComplete.id as string);

      await postThreadReply(channelId, threadTs,
        `🎉 Great work ${taskToComplete.assigned_to_name}! Task marked as *done*:\n> ${taskToComplete.task_text}\n\nNice one — I've stopped the follow-ups.`
      );
      await supabase.from("task_comments").insert([
        {
          task_id: taskToComplete.id,
          author_type: "assignee",
          author_name: taskToComplete.assigned_to_name,
          content: rawText,
          sent_to_slack: false,
        },
        {
          task_id: taskToComplete.id,
          author_type: "system",
          author_name: "System",
          content: `${taskToComplete.assigned_to_name} marked this task as done.`,
          sent_to_slack: true,
        },
      ]);
      await sendDirectMessage(
        brandonUserId,
        `✅ *Task Completed*\n\n*Assignee:* ${taskToComplete.assigned_to_name}\n*Task:* ${taskToComplete.task_text}\n\nThis task has been marked as done.`
      );
      console.log("[thread-cmd] completion via bot mention:", taskToComplete.id);
      return;
    }
  }

  console.log("[thread-cmd] parsing command:", humanText.slice(0, 150));

  const allActiveTaskTexts = [...new Set(
    activeThreadTasks
      .filter((t) => t.status === "active" || t.status === "revision_requested")
      .map((t) => t.task_text as string)
  )];
  const allClosedTaskTexts = [...new Set(
    threadTasks
      .filter((t) => t.status === "cancelled" || t.status === "completed" || t.status === "escalated")
      .map((t) => t.task_text as string)
  )];

  const command = await parseThreadCommand({
    messageText: humanText,
    existingTaskText,
    allTaskTexts: allActiveTaskTexts,
    closedTaskTexts: allClosedTaskTexts,
    existingAssigneeNames,
    teamMemberNames: teamMembers.map((m) => m.name),
  });

  if (!command || command.intent === "unknown") {
    // Only show the help menu if the message looked like an attempted command
    // (has some meaningful content beyond just a greeting or name)
    const looksLikeAttemptedCommand = textContent.length > 10;
    if (looksLikeAttemptedCommand) {
      await postThreadReply(
        channelId,
        threadTs,
        `Hey, I'm not sure what you'd like me to do here. You can say things like:\n` +
          `• "add @Person to this task"\n` +
          `• "remove @Person from this task"\n` +
          `• "reassign this to @Person"\n` +
          `• "add another task: [description]"\n` +
          `• "cancel this task"`
      );
    }
    return;
  }

  const senderName = await getSlackUserName(senderId);

  // Helper: resolve names + mentioned IDs → members
  function resolveMembers(names: string[], ids: string[]): Array<{ id: string; name: string }> {
    const result: Array<{ id: string; name: string }> = [];
    for (const id of ids) {
      const m = teamMembers.find((t) => t.id === id);
      if (m && !result.find((r) => r.id === m.id)) result.push(m);
    }
    for (const name of names) {
      const m = teamMembers.find(
        (t) =>
          t.name.toLowerCase().includes(name.toLowerCase()) ||
          name.toLowerCase().includes(t.name.toLowerCase())
      );
      if (m && !result.find((r) => r.id === m.id)) result.push(m);
    }
    return result;
  }

  const nextFollowupAt = calculateNextFollowupAt(0, new Date(), process.env.TEAM_TIMEZONE ?? "America/New_York");

  // ── ADD ASSIGNEE ─────────────────────────────────────────────────────────
  if (command.intent === "add_assignee") {
    const toAdd = resolveMembers(command.addNames, mentionedIds);
    if (toAdd.length === 0) {
      await postThreadReply(channelId, threadTs, "I couldn't figure out who to add. Please @mention them directly.");
      return;
    }

    // Only add people not already assigned
    const alreadyIds = new Set(activeThreadTasks.map((t) => t.assigned_to_id as string));
    const newMembers = toAdd.filter((m) => !alreadyIds.has(m.id));

    if (newMembers.length === 0) {
      await postThreadReply(channelId, threadTs, `${toAdd.map((m) => `<@${m.id}>`).join(", ")} ${toAdd.length === 1 ? "is" : "are"} already assigned to this task.`);
      return;
    }

    const uniqueAddTaskTexts = [...new Set(activeThreadTasks.map((t) => t.task_text as string))];
    const inserts = newMembers.flatMap((member) =>
      uniqueAddTaskTexts.map((taskText) => ({
        task_text: taskText,
        raw_message: rawText,
        assigned_to_id: member.id,
        assigned_to_name: member.name,
        assignee_ids: [member.id],
        assignee_names: [member.name],
        assigned_by_id: senderId,
        assigned_by_name: senderName,
        channel_id: channelId,
        message_ts: event.ts as string,
        thread_ts: threadTs,
        status: "active",
        followup_count: 0,
        max_followups: 5,
        next_followup_at: nextFollowupAt?.toISOString() ?? null,
        assignee_timezone: process.env.TEAM_TIMEZONE ?? "America/New_York",
      }))
    );

    await supabase.from("tasks").insert(inserts);

    const addedMentions = newMembers.map((m) => `<@${m.id}>`).join(", ");
    const addedTaskCount = uniqueAddTaskTexts.length;
    const addedTaskWord = addedTaskCount === 1 ? "task" : `${addedTaskCount} tasks`;
    await postThreadReply(
      channelId,
      threadTs,
      `✅ Added ${addedMentions} to ${addedTaskWord} in this thread.\n\n${addedMentions} — please reply *"done"* or *"Task N done"* in this thread when each task is complete. Use this thread for any questions.`
    );
    console.log("[thread-cmd] add_assignee:", newMembers.map((m) => m.name).join(", "), "tasks:", addedTaskCount);
    return;
  }

  // ── REMOVE ASSIGNEE ──────────────────────────────────────────────────────
  if (command.intent === "remove_assignee") {
    const toRemove = resolveMembers(command.removeNames, mentionedIds.filter((id) => {
      // Only treat as "remove" targets if they're currently assigned
      return threadTasks.some((t) => t.assigned_to_id === id);
    }));

    if (toRemove.length === 0) {
      await postThreadReply(channelId, threadTs, "I couldn't find who to remove. Please @mention them directly.");
      return;
    }

    const removeIds = toRemove.map((m) => m.id);

    // Resolve which task text to target:
    // 1. GPT provided a targetTaskText → use it
    // 2. GPT didn't but the message references "task N" → positional fallback
    let effectiveRemoveTargetText = command.targetTaskText;
    if (!effectiveRemoveTargetText) {
      const taskNumFallback = rawText.match(/\btask\s*(\d+)\b/i);
      if (taskNumFallback) {
        const tIdx = parseInt(taskNumFallback[1]) - 1;
        const orderedActiveTexts = [...new Set(activeThreadTasks.map(t => t.task_text as string))];
        if (tIdx >= 0 && tIdx < orderedActiveTexts.length) {
          effectiveRemoveTargetText = orderedActiveTexts[tIdx];
        }
      }
    }

    // If a specific task text was identified (by GPT or positional fallback), limit to that task.
    // Otherwise cancel all active tasks for these people in the thread.
    let candidateRemoveTasks = activeThreadTasks.filter(t => removeIds.includes(t.assigned_to_id as string));
    if (effectiveRemoveTargetText) {
      const tLower = effectiveRemoveTargetText.toLowerCase();
      const byText = candidateRemoveTasks.filter(t => {
        const text = (t.task_text as string).toLowerCase();
        return text === tLower || text.includes(tLower) || tLower.includes(text);
      });
      if (byText.length > 0) candidateRemoveTasks = byText;
    }

    await supabase
      .from("tasks")
      .update({ status: "cancelled", next_followup_at: null })
      .in("id", candidateRemoveTasks.map(t => t.id as string));

    const removedMentions = toRemove.map((m) => `<@${m.id}>`).join(", ");
    await postThreadReply(channelId, threadTs, `🗑️ Removed ${removedMentions} from this task.`);
    console.log("[thread-cmd] remove_assignee:", toRemove.map((m) => m.name).join(", "), "tasks:", candidateRemoveTasks.length);
    return;
  }

  // ── REASSIGN ─────────────────────────────────────────────────────────────
  if (command.intent === "reassign") {
    const toAdd = resolveMembers(command.addNames, mentionedIds);
    if (toAdd.length === 0) {
      await postThreadReply(channelId, threadTs, "I couldn't figure out who to reassign to. Please @mention them directly.");
      return;
    }

    const alreadyAssignedIds = new Set(activeThreadTasks.map((t) => t.assigned_to_id as string));
    const toAddIds = new Set(toAdd.map((m) => m.id));

    // Cancel tasks for people NOT in the new assignee list
    const tasksToCancel = activeThreadTasks.filter((t) => !toAddIds.has(t.assigned_to_id as string));
    if (tasksToCancel.length > 0) {
      await supabase.from("tasks").update({ status: "cancelled", next_followup_at: null }).in("id", tasksToCancel.map((t) => t.id as string));
    }

    // Only create new tasks for people NOT already assigned.
    // Preserve ALL unique task texts — one row per (task text × new member).
    const newMembers = toAdd.filter((m) => !alreadyAssignedIds.has(m.id));
    if (newMembers.length > 0) {
      const uniqueTaskTexts = [...new Set(activeThreadTasks.map((t) => t.task_text as string))];
      const inserts = newMembers.flatMap((member) =>
        uniqueTaskTexts.map((taskText) => ({
          task_text: taskText,
          raw_message: rawText,
          assigned_to_id: member.id,
          assigned_to_name: member.name,
          assignee_ids: [member.id],
          assignee_names: [member.name],
          assigned_by_id: senderId,
          assigned_by_name: senderName,
          channel_id: channelId,
          message_ts: event.ts as string,
          thread_ts: threadTs,
          status: "active",
          followup_count: 0,
          max_followups: 5,
          next_followup_at: nextFollowupAt?.toISOString() ?? null,
          assignee_timezone: process.env.TEAM_TIMEZONE ?? "America/New_York",
        }))
      );
      await supabase.from("tasks").insert(inserts);
    }

    const newMentions = toAdd.map((m) => `<@${m.id}>`).join(", ");
    const reassignedTaskCount = [...new Set(activeThreadTasks.map((t) => t.task_text as string))].length;
    const taskWord = reassignedTaskCount === 1 ? "task" : `${reassignedTaskCount} tasks`;
    await postThreadReply(
      channelId,
      threadTs,
      `✅ Reassigned ${taskWord} to ${newMentions}.\n\n${newMentions} — please reply *"done"* in this thread when each task is complete. Use this thread for any questions.`
    );
    console.log("[thread-cmd] reassign to:", toAdd.map((m) => m.name).join(", "));
    return;
  }

  // ── ADD TASK ─────────────────────────────────────────────────────────────
  if (command.intent === "add_task") {
    const newText = command.newTaskText?.trim();
    if (!newText) {
      await postThreadReply(channelId, threadTs, "I couldn't figure out what the new task should be. Could you be more specific?");
      return;
    }

    // Who should the new task go to?
    let assignees: Array<{ id: string; name: string }> = [];
    if (command.keepExistingAssignees) {
      // Same people as current thread
      assignees = [
        ...new Set(
          activeThreadTasks.map((t) => t.assigned_to_id as string)
        ),
      ].map((id) => {
        const t = activeThreadTasks.find((x) => x.assigned_to_id === id)!;
        return { id, name: t.assigned_to_name as string };
      });
    }
    // Supplement or replace with explicitly named people
    const namedAssignees = resolveMembers(command.addNames, mentionedIds);
    for (const m of namedAssignees) {
      if (!assignees.find((a) => a.id === m.id)) assignees.push(m);
    }

    if (assignees.length === 0) {
      // Default to current thread assignees rather than asking
      assignees = [...new Set(activeThreadTasks.map((t) => t.assigned_to_id as string))].map((id) => {
        const t = activeThreadTasks.find((x) => x.assigned_to_id === id)!;
        return { id, name: t.assigned_to_name as string };
      });
    }
    if (assignees.length === 0) {
      await postThreadReply(channelId, threadTs, "Who should this new task be assigned to? Please @mention them.");
      return;
    }

    const inserts = assignees.map((member) => ({
      task_text: newText,
      raw_message: rawText,
      assigned_to_id: member.id,
      assigned_to_name: member.name,
      assignee_ids: [member.id],
      assignee_names: [member.name],
      assigned_by_id: senderId,
      assigned_by_name: senderName,
      channel_id: channelId,
      message_ts: event.ts as string,
      thread_ts: threadTs,
      status: "active",
      followup_count: 0,
      max_followups: 5,
      next_followup_at: nextFollowupAt?.toISOString() ?? null,
      assignee_timezone: process.env.TEAM_TIMEZONE ?? "America/New_York",
    }));

    await supabase.from("tasks").insert(inserts);

    const taskMentions = assignees.map((m) => `<@${m.id}>`).join(", ");

    await postThreadReply(
      channelId,
      threadTs,
      `✅ *New task added*\n\n*Assigned to:* ${taskMentions}\n\n${formatTaskBody(newText)}\n\n${taskMentions} — please reply *"done"* in this thread when complete. Use this thread for any questions.`
    );
    console.log("[thread-cmd] add_task for:", assignees.map((m) => m.name).join(", "), "task:", newText.slice(0, 80));
    return;
  }

  // ── REOPEN TASK ───────────────────────────────────────────────────────────
  if (command.intent === "reopen_task") {
    const { data: closedTasks } = await supabase
      .from("tasks")
      .select("*")
      .eq("thread_ts", threadTs)
      .in("status", ["cancelled", "completed"])
      .order("created_at", { ascending: false });

    if (!closedTasks || closedTasks.length === 0) {
      await postThreadReply(channelId, threadTs, "There are no completed or cancelled tasks in this thread to reopen.");
      return;
    }

    // Target a specific task text if GPT identified one; otherwise all closed tasks
    let tasksToReopen = closedTasks;
    if (command.targetTaskText) {
      const tLower = command.targetTaskText.toLowerCase();
      const matched = closedTasks.filter((t) => {
        const text = (t.task_text as string).toLowerCase();
        return text === tLower || text.includes(tLower) || tLower.includes(text);
      });
      if (matched.length > 0) tasksToReopen = matched;
    }

    const reopenTaskText = tasksToReopen[0].task_text as string;
    const nextFollowupAt2 = calculateNextFollowupAt(0, new Date(), process.env.TEAM_TIMEZONE ?? "America/New_York");

    // If the command specifies assignees ("assign it only to @Harry"), restrict to those people.
    // GPT returns addNames / mentionedIds + keepExistingAssignees=false for "only to @X" phrasing.
    const explicitReopenAssignees = resolveMembers(command.addNames, mentionedIds);
    const isAssigneeRestricted = explicitReopenAssignees.length > 0 && !command.keepExistingAssignees;

    if (isAssigneeRestricted) {
      const explicitIds = new Set(explicitReopenAssignees.map((m) => m.id));

      // Reopen only the rows for the specified assignees
      const rowsForThem = tasksToReopen.filter((t) => explicitIds.has(t.assigned_to_id as string));

      if (rowsForThem.length > 0) {
        // Existing rows — just flip them back to active
        await supabase.from("tasks").update({
          status: "active",
          completed_at: null,
          next_followup_at: nextFollowupAt2?.toISOString() ?? null,
          followup_count: 0,
        }).in("id", rowsForThem.map((t) => t.id as string));
      } else {
        // No existing row for this person — create a fresh one
        await supabase.from("tasks").insert(
          explicitReopenAssignees.map((member) => ({
            task_text: reopenTaskText,
            raw_message: rawText,
            assigned_to_id: member.id,
            assigned_to_name: member.name,
            assignee_ids: [member.id],
            assignee_names: [member.name],
            assigned_by_id: senderId,
            assigned_by_name: senderName,
            channel_id: channelId,
            message_ts: event.ts as string,
            thread_ts: threadTs,
            status: "active",
            followup_count: 0,
            max_followups: 5,
            next_followup_at: nextFollowupAt2?.toISOString() ?? null,
            assignee_timezone: process.env.TEAM_TIMEZONE ?? "America/New_York",
          }))
        );
      }

      const assigneeMentions = explicitReopenAssignees.map((m) => `<@${m.id}>`).join(", ");
      await postThreadReply(channelId, threadTs,
        `🔁 Task reopened and assigned to ${assigneeMentions}.\n\n${formatTaskBody(reopenTaskText)}\n\n${assigneeMentions} — please reply *"done"* when complete.`
      );
      console.log("[thread-cmd] reopen_task (restricted) — assignees:", explicitReopenAssignees.map((m) => m.name).join(", "));
      return;
    }

    // No assignee restriction — reopen all matched rows
    const idsToReopen = [...new Set(tasksToReopen.map((t) => t.id as string))];
    await supabase.from("tasks").update({
      status: "active",
      completed_at: null,
      next_followup_at: nextFollowupAt2?.toISOString() ?? null,
      followup_count: 0,
    }).in("id", idsToReopen);

    const assigneeMentions = [...new Set(tasksToReopen.map((t) => t.assigned_to_id as string))]
      .map((id) => `<@${id}>`).join(", ");
    await postThreadReply(channelId, threadTs,
      `🔁 Task reopened and follow-ups restarted.\n\n*Assigned to:* ${assigneeMentions}\n\n${formatTaskBody(reopenTaskText)}\n\n${assigneeMentions} — please reply *"done"* when complete.`
    );
    console.log("[thread-cmd] reopen_task — reopened", idsToReopen.length, "task(s)");
    return;
  }

  // ── CANCEL TASK ───────────────────────────────────────────────────────────
  if (command.intent === "cancel_task") {
    // Target a specific task if GPT identified one; otherwise cancel all active tasks
    let tasksToCancel = activeThreadTasks;
    if (command.targetTaskText) {
      const tLower = command.targetTaskText.toLowerCase();
      const matched = activeThreadTasks.filter((t) => {
        const text = (t.task_text as string).toLowerCase();
        return text === tLower || text.includes(tLower) || tLower.includes(text);
      });
      if (matched.length > 0) tasksToCancel = matched;
    }
    const existingIds = tasksToCancel.map((t) => t.id as string);
    await supabase.from("tasks").update({ status: "cancelled", next_followup_at: null }).in("id", existingIds);
    const cancelledTexts = [...new Set(tasksToCancel.map((t) => t.task_text as string))];
    const taskDesc = cancelledTexts.length === 1 ? `"${cancelledTexts[0]}"` : `${cancelledTexts.length} tasks`;
    await postThreadReply(
      channelId,
      threadTs,
      `🗑️ Got it — ${taskDesc} cancelled. No further follow-ups will be sent.\n\nIf you need to assign a new task, just @mention me here with the details.`
    );
    console.log("[thread-cmd] cancel_task — cancelled", existingIds.length, "task(s):", cancelledTexts.join("; "));
    return;
  }

  // ── CANCEL AND REPLACE ────────────────────────────────────────────────────
  if (command.intent === "cancel_and_replace") {
    const newText = command.newTaskText?.trim();
    if (!newText) {
      await postThreadReply(channelId, threadTs, "I cancelled the old task but couldn't figure out the new one. What should the new task be?");
      // Cancel anyway
      const existingIds = activeThreadTasks.map((t) => t.id as string);
      await supabase.from("tasks").update({ status: "cancelled", next_followup_at: null }).in("id", existingIds);
      return;
    }

    // Cancel existing tasks
    const existingIds = activeThreadTasks.map((t) => t.id as string);
    await supabase.from("tasks").update({ status: "cancelled", next_followup_at: null }).in("id", existingIds);

    // Determine assignees, honouring thread history:
    // - keepExistingAssignees=true ("add also @Harry") → keep Makoy + add Harry
    // - explicit new names only ("replace with @Harry") → only Harry
    // - no names mentioned → keep existing unchanged
    const namedAssignees = resolveMembers(command.addNames, mentionedIds);
    const existingAssignees = [...new Set(activeThreadTasks.map((t) => t.assigned_to_id as string))].map((id) => {
      const t = activeThreadTasks.find((x) => x.assigned_to_id === id)!;
      return { id, name: t.assigned_to_name as string };
    });

    let assignees: Array<{ id: string; name: string }>;
    if (command.keepExistingAssignees) {
      assignees = [...existingAssignees];
      for (const m of namedAssignees) {
        if (!assignees.find((a) => a.id === m.id)) assignees.push(m);
      }
    } else if (namedAssignees.length > 0) {
      assignees = namedAssignees;
    } else {
      assignees = existingAssignees;
    }

    const inserts = assignees.map((member) => ({
      task_text: newText,
      raw_message: rawText,
      assigned_to_id: member.id,
      assigned_to_name: member.name,
      assignee_ids: [member.id],
      assignee_names: [member.name],
      assigned_by_id: senderId,
      assigned_by_name: senderName,
      channel_id: channelId,
      message_ts: event.ts as string,
      thread_ts: threadTs,
      status: "active",
      followup_count: 0,
      max_followups: 5,
      next_followup_at: nextFollowupAt?.toISOString() ?? null,
      assignee_timezone: process.env.TEAM_TIMEZONE ?? "America/New_York",
    }));

    await supabase.from("tasks").insert(inserts);

    const taskMentions = assignees.map((m) => `<@${m.id}>`).join(", ");

    await postThreadReply(
      channelId,
      threadTs,
      `✅ *Task updated*\n\n*Assigned to:* ${taskMentions}\n\n${formatTaskBody(newText)}\n\n${taskMentions} — please reply *"done"* in this thread when complete. Use this thread for any questions.`
    );
    console.log("[thread-cmd] cancel_and_replace — new task:", newText.slice(0, 80), "for:", assignees.map((m) => m.name).join(", "));
    return;
  }
}

async function handleVoiceThreadCommand(
  event: Record<string, unknown>,
  audioFile: Record<string, unknown>,
  supabase: ReturnType<typeof createSupabaseAdmin>,
  brandonUserId: string
) {
  const channelId = event.channel as string;
  const threadTs = event.thread_ts as string;
  const senderId = event.user as string;

  // ── Transcribe (silently — only reply if a real command is recognized) ──────
  const fileUrl = (audioFile.url_private_download as string) || (audioFile.url_private as string);
  const fileName = (audioFile.name as string) || "audio.mp4";
  if (!fileUrl) {
    console.error("[voice-thread] no file URL available");
    return;
  }

  const audioBuffer = await downloadSlackFile(fileUrl);
  if (!audioBuffer) {
    console.error("[voice-thread] failed to download audio");
    return;
  }

  const transcription = await transcribeAudio(audioBuffer, fileName);
  if (!transcription) {
    console.error("[voice-thread] transcription failed");
    return;
  }

  console.log("[voice-thread] transcription:", transcription.slice(0, 200));

  // ── Check if Brandon is answering the "who should do this?" question via voice ──
  const { data: pendingVoice } = await supabase
    .from("pending_voice_tasks")
    .select("*")
    .eq("thread_ts", threadTs)
    .eq("resolved", false)
    .maybeSingle();

  if (pendingVoice && senderId === process.env.SLACK_BRANDON_USER_ID) {
    const teamMembers2 = await getWorkspaceMembers();
    const botUserId2 = await getBotUserId();
    const botEnvId2 = process.env.SLACK_BOT_USER_ID ?? "";

    // Try to find a team member name in the transcription
    const matched = teamMembers2.filter((m) => {
      const firstName = m.name.split(" ")[0].toLowerCase();
      return (
        transcription.toLowerCase().includes(m.name.toLowerCase()) ||
        transcription.toLowerCase().includes(firstName)
      );
    }).filter((m) => m.id !== botUserId2 && m.id !== botEnvId2);

    if (matched.length > 0) {
      const nextFollowupAt2 = calculateNextFollowupAt(0, new Date(), process.env.TEAM_TIMEZONE ?? "America/New_York");
      await supabase.from("tasks").insert(matched.map((member) => ({
        task_text: pendingVoice.task_text,
        raw_message: pendingVoice.transcription,
        voice_transcription: pendingVoice.transcription,
        assigned_to_id: member.id,
        assigned_to_name: member.name,
        assignee_ids: [member.id],
        assignee_names: [member.name],
        assigned_by_id: pendingVoice.created_by_id,
        assigned_by_name: pendingVoice.created_by_name,
        channel_id: pendingVoice.channel_id,
        message_ts: pendingVoice.message_ts,
        thread_ts: pendingVoice.thread_ts,
        status: "active",
        followup_count: 0,
        max_followups: 5,
        next_followup_at: nextFollowupAt2?.toISOString() ?? null,
        assignee_timezone: process.env.TEAM_TIMEZONE ?? "America/New_York",
      })));
      await supabase.from("pending_voice_tasks").update({ resolved: true }).eq("id", pendingVoice.id);
      const mentions = matched.map((m) => `<@${m.id}>`).join(", ");
      await postThreadReply(pendingVoice.channel_id, pendingVoice.thread_ts,
        `✅ *Task assigned*\n\n*Assigned to:* ${mentions}\n\n${formatTaskBody(pendingVoice.task_text)}\n\n${mentions} — please reply *"done"* in this thread when the task is complete.`
      );
      return;
    }
  }

  // ── Load thread context ───────────────────────────────────────────────────
  const { data: threadTasks } = await supabase
    .from("tasks")
    .select("*")
    .eq("thread_ts", threadTs)
    .order("created_at", { ascending: true });

  const teamMembers = await getWorkspaceMembers();

  // No existing tasks — treat the voice note as a new task creation
  if (!threadTasks || threadTasks.length === 0) {
    console.log("[voice-thread] no existing tasks in thread — creating new task from voice");
    await handleVoiceMessage(event, audioFile, supabase, brandonUserId);
    return;
  }

  const activeThreadTasks = threadTasks.filter((t) => t.status !== "cancelled" && t.status !== "escalated");
  const contextTasks = activeThreadTasks.length > 0 ? activeThreadTasks : threadTasks;
  const existingTaskText = contextTasks[contextTasks.length - 1].task_text as string;
  const existingAssigneeNames: string[] = [
    ...new Set(contextTasks.flatMap((t) => (t.assignee_names?.length ? t.assignee_names : [t.assigned_to_name]) as string[])),
  ];

  // ── Summary request via voice note ───────────────────────────────────────
  const isVoiceSummaryRequest =
    /\b(what (are|is)|list|show|status of).*task|task.*(list|status|what)/i.test(transcription) ||
    /\bsummar(y|ize|ies)\b/i.test(transcription);

  if (isVoiceSummaryRequest && senderId === brandonUserId) {
    console.log("[voice-thread] summary request via voice");
    const { data: summaryTasks } = await supabase
      .from("tasks")
      .select("*")
      .eq("thread_ts", threadTs)
      .order("created_at", { ascending: true });

    const tasks = summaryTasks ?? [];
    if (tasks.length === 0) {
      await postThreadReply(channelId, threadTs, "No tasks found in this thread.");
      return;
    }

    const groupMap = new Map<string, typeof tasks>();
    for (const t of tasks) {
      const key = t.task_text as string;
      if (!groupMap.has(key)) groupMap.set(key, []);
      groupMap.get(key)!.push(t);
    }

    const taskCount = groupMap.size;
    const summaryLines = [...groupMap.entries()].map(([taskText, group], i) => {
      const activeRows    = group.filter(t => t.status === "active" || t.status === "revision_requested");
      const completedRows = group.filter(t => t.status === "completed");
      const cancelledRows = group.filter(t => t.status === "cancelled" || t.status === "escalated");

      const allDone    = group.every(t => t.status === "completed");
      const noneActive = activeRows.length === 0 && completedRows.length === 0;
      const icon  = allDone ? "✅" : noneActive ? "🗑️" : "🔵";
      const label = taskCount === 1 ? `*Task:*` : `*Task ${i + 1}:*`;

      const parts: string[] = [`${icon} ${label} ${taskText}`];
      if (activeRows.length > 0) {
        const names = activeRows.map(t => `<@${t.assigned_to_id}>`).join(", ");
        parts.push(`   ⏳ *In progress:* ${names}`);
      }
      if (completedRows.length > 0) {
        parts.push(`   ✅ *Completed by:* ${completedRows.map(t => `<@${t.assigned_to_id}>`).join(", ")}`);
      }
      if (cancelledRows.length > 0 && (activeRows.length > 0 || completedRows.length > 0)) {
        const from = cancelledRows.map(t => t.assigned_to_name as string).join(", ");
        const to   = [...activeRows, ...completedRows].map(t => t.assigned_to_name as string).join(", ");
        parts.push(`   🔄 *History:* Originally assigned to ${from} → Reassigned to ${to}`);
      } else if (noneActive && cancelledRows.length > 0) {
        parts.push(`   🗑️ *Cancelled* — was assigned to ${cancelledRows.map(t => `<@${t.assigned_to_id}>`).join(", ")}`);
      }
      return parts.join("\n");
    });

    await postThreadReply(channelId, threadTs, `📋 *Task Summary*\n\n${summaryLines.join("\n\n")}`);
    return;
  }

  // ── Parse the transcription as a thread command ───────────────────────────
  const voiceAllActiveTaskTexts = [...new Set(activeThreadTasks.map((t) => t.task_text as string))];
  const voiceClosedTaskTexts = [...new Set(
    threadTasks
      .filter((t) => t.status === "cancelled" || t.status === "completed" || t.status === "escalated")
      .map((t) => t.task_text as string)
  )];

  const command = await parseThreadCommand({
    messageText: transcription,
    existingTaskText,
    allTaskTexts: voiceAllActiveTaskTexts,
    closedTaskTexts: voiceClosedTaskTexts,
    existingAssigneeNames,
    teamMemberNames: teamMembers.map((m) => m.name),
  });

  if (!command || command.intent === "unknown") {
    // Not a task command — stay completely silent. Brandon is just talking.
    console.log("[voice-thread] no task intent detected — staying silent. transcription:", transcription.slice(0, 100));
    return;
  }

  const senderName = await getSlackUserName(senderId);
  const botUserId = await getBotUserId();
  const botEnvId = process.env.SLACK_BOT_USER_ID ?? "";
  const nextFollowupAt = calculateNextFollowupAt(0, new Date(), process.env.TEAM_TIMEZONE ?? "America/New_York");

  // Resolve names mentioned in the transcription to Slack member objects
  function resolveMembers(names: string[], ids: string[] = []): Array<{ id: string; name: string }> {
    const result: Array<{ id: string; name: string }> = [];
    for (const id of ids) {
      const m = teamMembers.find((t) => t.id === id);
      if (m && !result.find((r) => r.id === m.id)) result.push(m);
    }
    for (const name of names) {
      const m = teamMembers.find(
        (t) =>
          t.name.toLowerCase().includes(name.toLowerCase()) ||
          name.toLowerCase().includes(t.name.toLowerCase())
      );
      if (m && !result.find((r) => r.id === m.id)) result.push(m);
    }
    // Never assign to the bot itself
    return result.filter((m) => m.id !== botUserId && m.id !== botEnvId);
  }

  // ── ADD ASSIGNEE ──────────────────────────────────────────────────────────
  if (command.intent === "add_assignee") {
    const toAdd = resolveMembers(command.addNames);
    if (toAdd.length === 0) {
      await postThreadReply(channelId, threadTs, "I couldn't figure out who to add from the voice note. Please @mention them in a text reply.");
      return;
    }
    const alreadyIds = new Set(activeThreadTasks.map((t) => t.assigned_to_id as string));
    const newMembers = toAdd.filter((m) => !alreadyIds.has(m.id));
    if (newMembers.length === 0) {
      await postThreadReply(channelId, threadTs, `${toAdd.map((m) => `<@${m.id}>`).join(", ")} ${toAdd.length === 1 ? "is" : "are"} already assigned to this task.`);
      return;
    }
    const voiceAddUniqueTexts = [...new Set(activeThreadTasks.map((t) => t.task_text as string))];
    await supabase.from("tasks").insert(newMembers.flatMap((member) =>
      voiceAddUniqueTexts.map((taskText) => ({
        task_text: taskText,
        raw_message: transcription,
        voice_transcription: transcription,
        assigned_to_id: member.id,
        assigned_to_name: member.name,
        assignee_ids: [member.id],
        assignee_names: [member.name],
        assigned_by_id: senderId,
        assigned_by_name: senderName,
        channel_id: channelId,
        message_ts: event.ts as string,
        thread_ts: threadTs,
        status: "active",
        followup_count: 0,
        max_followups: 5,
        next_followup_at: nextFollowupAt?.toISOString() ?? null,
        assignee_timezone: process.env.TEAM_TIMEZONE ?? "America/New_York",
      }))
    ));
    const addedMentions = newMembers.map((m) => `<@${m.id}>`).join(", ");
    const voiceAddedCount = voiceAddUniqueTexts.length;
    const voiceAddedWord = voiceAddedCount === 1 ? "task" : `${voiceAddedCount} tasks`;
    await postThreadReply(channelId, threadTs, `✅ Added ${addedMentions} to ${voiceAddedWord} in this thread.\n\n${addedMentions} — please reply *"done"* or *"Task N done"* in this thread when each task is complete.`);
    return;
  }

  // ── REMOVE ASSIGNEE ───────────────────────────────────────────────────────
  if (command.intent === "remove_assignee") {
    const toRemove = resolveMembers(command.removeNames);
    if (toRemove.length === 0) {
      await postThreadReply(channelId, threadTs, "I couldn't figure out who to remove from the voice note. Please @mention them in a text reply.");
      return;
    }

    // Identify which specific task to remove from:
    // 1. GPT set targetTaskText → use it
    // 2. Keyword overlap: find which active task best matches words in the transcription
    // 3. Fallback: cancel all of the person's active tasks in this thread
    let voiceRemoveTargetText = command.targetTaskText;
    if (!voiceRemoveTargetText) {
      const stopWords = new Set(["the", "task", "from", "only", "that", "this", "and", "for", "please", "just", "remove", "unassign", "harry", "makoy"]);
      const meaningfulWords = transcription
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, "")
        .split(/\s+/)
        .filter(w => w.length > 2 && !stopWords.has(w));
      const uniqueActiveTexts = [...new Set(activeThreadTasks.map(t => t.task_text as string))];
      let bestText = "";
      let bestScore = 0;
      for (const taskText of uniqueActiveTexts) {
        const taskWords = taskText.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/);
        const score = meaningfulWords.filter(w => taskWords.some(tw => tw.includes(w) || w.includes(tw))).length;
        if (score > bestScore) { bestScore = score; bestText = taskText; }
      }
      if (bestScore >= 2) voiceRemoveTargetText = bestText;
    }

    const removeIds = toRemove.map((m) => m.id);
    let voiceRemoveCandidates = activeThreadTasks.filter(t => removeIds.includes(t.assigned_to_id as string));
    if (voiceRemoveTargetText) {
      const tLower = voiceRemoveTargetText.toLowerCase();
      const byText = voiceRemoveCandidates.filter(t => {
        const text = (t.task_text as string).toLowerCase();
        return text === tLower || text.includes(tLower) || tLower.includes(text);
      });
      if (byText.length > 0) voiceRemoveCandidates = byText;
    }

    await supabase.from("tasks").update({ status: "cancelled", next_followup_at: null })
      .in("id", voiceRemoveCandidates.map((t) => t.id as string));

    const removedMentions = toRemove.map((m) => `<@${m.id}>`).join(", ");
    const removedTaskDesc = voiceRemoveTargetText ? ` from "${voiceRemoveTargetText}"` : "";
    const stillActive = activeThreadTasks.filter(t => !voiceRemoveCandidates.some(c => c.id === t.id));
    const stillActiveMentions = [...new Set(stillActive.map(t => t.assigned_to_id as string))].map(id => `<@${id}>`).join(", ");
    await postThreadReply(channelId, threadTs,
      `🗑️ Removed ${removedMentions}${removedTaskDesc}.\n\n` +
      (stillActive.length > 0
        ? `The remaining task${stillActive.length === 1 ? "" : "s"} are still active with ${stillActiveMentions}.`
        : "No more active tasks in this thread.")
    );
    console.log("[voice-thread] remove_assignee:", toRemove.map(m => m.name).join(", "), "target:", voiceRemoveTargetText ?? "all", "cancelled:", voiceRemoveCandidates.length);
    return;
  }

  // ── REASSIGN ──────────────────────────────────────────────────────────────
  if (command.intent === "reassign") {
    const toAdd = resolveMembers(command.addNames);
    if (toAdd.length === 0) {
      await postThreadReply(channelId, threadTs, "I couldn't figure out who to reassign to from the voice note. Please @mention them in a text reply.");
      return;
    }

    const alreadyAssignedIds = new Set(activeThreadTasks.map((t) => t.assigned_to_id as string));
    const toAddIds = new Set(toAdd.map((m) => m.id));

    // Cancel tasks for people NOT in the new assignee list
    const tasksToCancel = activeThreadTasks.filter((t) => !toAddIds.has(t.assigned_to_id as string));
    if (tasksToCancel.length > 0) {
      await supabase.from("tasks").update({ status: "cancelled", next_followup_at: null }).in("id", tasksToCancel.map((t) => t.id as string));
    }

    // Only create new tasks for people NOT already assigned.
    // Preserve ALL unique task texts — one row per (task text × new member).
    const newMembers = toAdd.filter((m) => !alreadyAssignedIds.has(m.id));
    if (newMembers.length > 0) {
      const uniqueTaskTexts = [...new Set(activeThreadTasks.map((t) => t.task_text as string))];
      await supabase.from("tasks").insert(
        newMembers.flatMap((member) =>
          uniqueTaskTexts.map((taskText) => ({
            task_text: taskText,
            raw_message: transcription,
            voice_transcription: transcription,
            assigned_to_id: member.id,
            assigned_to_name: member.name,
            assignee_ids: [member.id],
            assignee_names: [member.name],
            assigned_by_id: senderId,
            assigned_by_name: senderName,
            channel_id: channelId,
            message_ts: event.ts as string,
            thread_ts: threadTs,
            status: "active",
            followup_count: 0,
            max_followups: 5,
            next_followup_at: nextFollowupAt?.toISOString() ?? null,
            assignee_timezone: process.env.TEAM_TIMEZONE ?? "America/New_York",
          }))
        )
      );
    }

    const newMentions = toAdd.map((m) => `<@${m.id}>`).join(", ");
    const voiceReassignCount = [...new Set(activeThreadTasks.map((t) => t.task_text as string))].length;
    const voiceTaskWord = voiceReassignCount === 1 ? "task" : `${voiceReassignCount} tasks`;
    await postThreadReply(channelId, threadTs, `✅ Reassigned ${voiceTaskWord} to ${newMentions}.\n\n${newMentions} — please reply *"done"* in this thread when each task is complete.`);
    return;
  }

  // ── ADD TASK ──────────────────────────────────────────────────────────────
  if (command.intent === "add_task") {
    const newText = command.newTaskText?.trim();
    if (!newText) {
      await postThreadReply(channelId, threadTs, "I heard a new task but couldn't understand the details. Could you type it out?");
      return;
    }
    let assignees: Array<{ id: string; name: string }> = [];
    if (command.keepExistingAssignees) {
      assignees = [...new Set(activeThreadTasks.map((t) => t.assigned_to_id as string))].map((id) => {
        const t = activeThreadTasks.find((x) => x.assigned_to_id === id)!;
        return { id, name: t.assigned_to_name as string };
      });
    }
    for (const m of resolveMembers(command.addNames)) {
      if (!assignees.find((a) => a.id === m.id)) assignees.push(m);
    }
    if (assignees.length === 0) {
      // Default to current thread assignees rather than asking
      assignees = [...new Set(activeThreadTasks.map((t) => t.assigned_to_id as string))].map((id) => {
        const t = activeThreadTasks.find((x) => x.assigned_to_id === id)!;
        return { id, name: t.assigned_to_name as string };
      });
    }
    if (assignees.length === 0) {
      await postThreadReply(channelId, threadTs, "Who should this new task be assigned to? Please @mention them in a text reply.");
      return;
    }
    await supabase.from("tasks").insert(assignees.map((member) => ({
      task_text: newText,
      raw_message: transcription,
      voice_transcription: transcription,
      assigned_to_id: member.id,
      assigned_to_name: member.name,
      assignee_ids: [member.id],
      assignee_names: [member.name],
      assigned_by_id: senderId,
      assigned_by_name: senderName,
      channel_id: channelId,
      message_ts: event.ts as string,
      thread_ts: threadTs,
      status: "active",
      followup_count: 0,
      max_followups: 5,
      next_followup_at: nextFollowupAt?.toISOString() ?? null,
      assignee_timezone: process.env.TEAM_TIMEZONE ?? "America/New_York",
    })));
    const taskMentions = assignees.map((m) => `<@${m.id}>`).join(", ");
    await postThreadReply(channelId, threadTs, `✅ *New task added*\n\n*Assigned to:* ${taskMentions}\n\n${formatTaskBody(newText)}\n\n${taskMentions} — please reply *"done"* in this thread when complete.`);
    return;
  }

  // ── REOPEN TASK ───────────────────────────────────────────────────────────
  if (command.intent === "reopen_task") {
    const { data: closedTasks } = await supabase
      .from("tasks")
      .select("*")
      .eq("thread_ts", threadTs)
      .in("status", ["cancelled", "completed"])
      .order("created_at", { ascending: false });

    if (!closedTasks || closedTasks.length === 0) {
      await postThreadReply(channelId, threadTs, "There are no completed or cancelled tasks in this thread to reopen.");
      return;
    }

    // Target a specific task text if GPT identified one; otherwise all closed tasks
    let voiceTasksToReopen = closedTasks;
    if (command.targetTaskText) {
      const tLower = command.targetTaskText.toLowerCase();
      const matched = closedTasks.filter((t) => {
        const text = (t.task_text as string).toLowerCase();
        return text === tLower || text.includes(tLower) || tLower.includes(text);
      });
      if (matched.length > 0) voiceTasksToReopen = matched;
    }

    const voiceReopenTaskText = voiceTasksToReopen[0].task_text as string;
    const nextFollowupAt2 = calculateNextFollowupAt(0, new Date(), process.env.TEAM_TIMEZONE ?? "America/New_York");

    // If specific assignees are named ("only to Harry"), restrict the reopen to those people
    const voiceReopenAssignees = resolveMembers(command.addNames);
    const voiceIsRestricted = voiceReopenAssignees.length > 0 && !command.keepExistingAssignees;

    if (voiceIsRestricted) {
      const explicitIds = new Set(voiceReopenAssignees.map((m) => m.id));
      const rowsForThem = voiceTasksToReopen.filter((t) => explicitIds.has(t.assigned_to_id as string));

      if (rowsForThem.length > 0) {
        await supabase.from("tasks").update({
          status: "active",
          completed_at: null,
          next_followup_at: nextFollowupAt2?.toISOString() ?? null,
          followup_count: 0,
        }).in("id", rowsForThem.map((t) => t.id as string));
      } else {
        // No existing row for this person — create a fresh one
        await supabase.from("tasks").insert(
          voiceReopenAssignees.map((member) => ({
            task_text: voiceReopenTaskText,
            raw_message: transcription,
            voice_transcription: transcription,
            assigned_to_id: member.id,
            assigned_to_name: member.name,
            assignee_ids: [member.id],
            assignee_names: [member.name],
            assigned_by_id: senderId,
            assigned_by_name: senderName,
            channel_id: channelId,
            message_ts: event.ts as string,
            thread_ts: threadTs,
            status: "active",
            followup_count: 0,
            max_followups: 5,
            next_followup_at: nextFollowupAt2?.toISOString() ?? null,
            assignee_timezone: process.env.TEAM_TIMEZONE ?? "America/New_York",
          }))
        );
      }

      const voiceAssigneeMentions = voiceReopenAssignees.map((m) => `<@${m.id}>`).join(", ");
      await postThreadReply(channelId, threadTs,
        `🔁 Task reopened and assigned to ${voiceAssigneeMentions}.\n\n${formatTaskBody(voiceReopenTaskText)}\n\n${voiceAssigneeMentions} — please reply *"done"* when complete.`
      );
      console.log("[voice-thread] reopen_task (restricted) — assignees:", voiceReopenAssignees.map((m) => m.name).join(", "));
      return;
    }

    // No assignee restriction — reopen all matched rows
    const idsToReopen = [...new Set(voiceTasksToReopen.map((t) => t.id as string))];
    await supabase.from("tasks").update({
      status: "active",
      completed_at: null,
      next_followup_at: nextFollowupAt2?.toISOString() ?? null,
      followup_count: 0,
    }).in("id", idsToReopen);

    const assigneeMentions = [...new Set(voiceTasksToReopen.map((t) => t.assigned_to_id as string))]
      .map((id) => `<@${id}>`).join(", ");
    await postThreadReply(channelId, threadTs,
      `🔁 Task reopened and follow-ups restarted.\n\n*Assigned to:* ${assigneeMentions}\n\n${formatTaskBody(voiceReopenTaskText)}\n\n${assigneeMentions} — please reply *"done"* when complete.`
    );
    console.log("[voice-thread] reopen_task — reopened", idsToReopen.length, "task(s)");
    return;
  }

  // ── CANCEL TASK ───────────────────────────────────────────────────────────
  if (command.intent === "cancel_task") {
    let voiceTasksToCancel = activeThreadTasks;
    if (command.targetTaskText) {
      const tLower = command.targetTaskText.toLowerCase();
      const matched = activeThreadTasks.filter((t) => {
        const text = (t.task_text as string).toLowerCase();
        return text === tLower || text.includes(tLower) || tLower.includes(text);
      });
      if (matched.length > 0) voiceTasksToCancel = matched;
    }
    await supabase.from("tasks").update({ status: "cancelled", next_followup_at: null }).in("id", voiceTasksToCancel.map((t) => t.id as string));
    const cancelledTexts = [...new Set(voiceTasksToCancel.map((t) => t.task_text as string))];
    const taskDesc = cancelledTexts.length === 1 ? `"${cancelledTexts[0]}"` : `${cancelledTexts.length} tasks`;
    await postThreadReply(channelId, threadTs, `🗑️ Got it — ${taskDesc} cancelled. No further follow-ups will be sent.`);
    return;
  }

  // ── CANCEL AND REPLACE ────────────────────────────────────────────────────
  if (command.intent === "cancel_and_replace") {
    const newText = command.newTaskText?.trim();
    await supabase.from("tasks").update({ status: "cancelled", next_followup_at: null }).in("id", activeThreadTasks.map((t) => t.id as string));
    if (!newText) {
      await postThreadReply(channelId, threadTs, "I cancelled the old task but couldn't catch the new one. What should the new task be?");
      return;
    }
    const namedAssignees = resolveMembers(command.addNames);
    const existingAssignees = [...new Set(activeThreadTasks.map((t) => t.assigned_to_id as string))].map((id) => {
      const t = activeThreadTasks.find((x) => x.assigned_to_id === id)!;
      return { id, name: t.assigned_to_name as string };
    });
    let assignees: Array<{ id: string; name: string }>;
    if (command.keepExistingAssignees) {
      assignees = [...existingAssignees];
      for (const m of namedAssignees) {
        if (!assignees.find((a) => a.id === m.id)) assignees.push(m);
      }
    } else if (namedAssignees.length > 0) {
      assignees = namedAssignees;
    } else {
      assignees = existingAssignees;
    }
    await supabase.from("tasks").insert(assignees.map((member) => ({
      task_text: newText,
      raw_message: transcription,
      voice_transcription: transcription,
      assigned_to_id: member.id,
      assigned_to_name: member.name,
      assignee_ids: [member.id],
      assignee_names: [member.name],
      assigned_by_id: senderId,
      assigned_by_name: senderName,
      channel_id: channelId,
      message_ts: event.ts as string,
      thread_ts: threadTs,
      status: "active",
      followup_count: 0,
      max_followups: 5,
      next_followup_at: nextFollowupAt?.toISOString() ?? null,
      assignee_timezone: process.env.TEAM_TIMEZONE ?? "America/New_York",
    })));
    const taskMentions = assignees.map((m) => `<@${m.id}>`).join(", ");
    await postThreadReply(channelId, threadTs, `✅ *Task updated*\n\n*Assigned to:* ${taskMentions}\n\n${formatTaskBody(newText)}\n\n${taskMentions} — please reply *"done"* in this thread when complete.`);
    return;
  }
}

async function handleVoiceMessage(
  event: Record<string, unknown>,
  audioFile: Record<string, unknown>,
  supabase: ReturnType<typeof createSupabaseAdmin>,
  brandonUserId: string
) {
  const channelId = event.channel as string;
  const messageTs = event.ts as string;
  const threadTs = messageTs;
  const senderId = event.user as string;

  const transcribingTs = await postThreadReply(
    channelId,
    threadTs,
    "🎙️ Got your voice note! Transcribing now..."
  );
  await saveBotMessageTs(supabase, channelId, threadTs, transcribingTs);

  const fileUrl =
    (audioFile.url_private_download as string) ||
    (audioFile.url_private as string);

  if (!fileUrl) {
    await postThreadReply(
      channelId,
      threadTs,
      "⚠️ I couldn't access the audio file. Make sure the bot has file access permissions."
    );
    return;
  }

  const audioBuffer = await downloadSlackFile(fileUrl);
  if (!audioBuffer) {
    await postThreadReply(
      channelId,
      threadTs,
      "⚠️ Failed to download the audio file. Make sure the bot has the `files:read` Slack permission (OAuth & Permissions → reinstall app after adding the scope)."
    );
    return;
  }

  const fileName = (audioFile.name as string) ?? "audio.mp4";
  const transcription = await transcribeAudio(audioBuffer, fileName);

  if (!transcription) {
    await postThreadReply(
      channelId,
      threadTs,
      "⚠️ I couldn't transcribe the audio. The file may be too short or unclear. Please try again."
    );
    return;
  }

  console.log("[voice] transcription:", transcription.slice(0, 200));

  const teamMembers = await getWorkspaceMembers();
  const parsed = await parseVoiceTranscription(transcription, teamMembers);

  if (!parsed || !parsed.hasTask) {
    await postThreadReply(
      channelId,
      threadTs,
      `📝 Here's what I heard:\n\n_"${transcription}"_\n\nThe assignee is not clear to me — please @mention the person directly in a reply so I can create the task.`
    );
    return;
  }

  // Check for @mentions in the message text itself
  const messageText = (event.text as string) ?? "";
  const mentionPattern = /<@([A-Z0-9]+)>/g;
  const slackMentions = [...messageText.matchAll(mentionPattern)]
    .map(m => m[1])
    .filter(id => id !== brandonUserId && id !== process.env.SLACK_BOT_USER_ID);

  let matchedMembers: Array<{ id: string; name: string }> = [];

  // First: use explicit Slack @mentions
  for (const slackId of slackMentions) {
    const member = teamMembers.find(m => m.id === slackId);
    if (member) matchedMembers.push(member);
  }

  // Second: always supplement with names mentioned in the voice recording
  if (parsed.mentionedNames.length > 0) {
    for (const mentionedName of parsed.mentionedNames) {
      const matched = teamMembers.find(
        m =>
          m.name.toLowerCase().includes(mentionedName.toLowerCase()) ||
          mentionedName.toLowerCase().includes(m.name.toLowerCase())
      );
      if (matched && !matchedMembers.find(x => x.id === matched.id)) {
        matchedMembers.push(matched);
      }
    }
  }

  // Never assign to the bot itself
  const botSelfId = await getBotUserId();
  const botSelfEnv = process.env.SLACK_BOT_USER_ID ?? "";
  matchedMembers = matchedMembers.filter((m) => m.id !== botSelfId && m.id !== botSelfEnv);

  // No assignee found — ask Brandon to clarify
  if (matchedMembers.length === 0) {
    const assignerName = await getSlackUserName(senderId);

    await supabase.from("pending_voice_tasks").insert({
      channel_id: channelId,
      thread_ts: threadTs,
      message_ts: messageTs,
      transcription,
      task_text: parsed.taskText,
      summary: parsed.summary,
      mentioned_names: parsed.mentionedNames,
      created_by_id: senderId,
      created_by_name: assignerName,
    });

    const pendingConfirmTs = await postThreadReply(
      channelId,
      threadTs,
      `📝 Transcribed your voice note!\n\n*Task:* ${parsed.summary}\n\n` +
        `<@${brandonUserId}> — who should this be assigned to? ` +
        `Please @mention them in a reply here and I'll create the task automatically.`
    );
    await saveBotMessageTs(supabase, channelId, threadTs, pendingConfirmTs);
    return;
  }

  // Create tasks for all matched assignees — split multi-task text into separate rows
  const assignerName = await getSlackUserName(senderId);
  const nextFollowupAt = calculateNextFollowupAt(
    0,
    new Date(),
    process.env.TEAM_TIMEZONE ?? "America/New_York"
  );

  // Split on ";" or newlines so each sub-task gets its own DB row and can be
  // individually marked done, rather than all being collapsed into one row.
  const taskLines = parsed.taskText
    .split(/\s*[;\n]\s*/)
    .map((l) => l.trim())
    .filter(Boolean);

  const taskInserts = matchedMembers.flatMap(member =>
    taskLines.map(taskLine => ({
      task_text: taskLine,
      raw_message: transcription,
      voice_transcription: transcription,
      assigned_to_id: member.id,
      assigned_to_name: member.name,
      assignee_ids: [member.id],
      assignee_names: [member.name],
      assigned_by_id: senderId,
      assigned_by_name: assignerName,
      channel_id: channelId,
      message_ts: messageTs,
      thread_ts: threadTs,
      status: "active",
      followup_count: 0,
      max_followups: 5,
      next_followup_at: nextFollowupAt?.toISOString() ?? null,
      assignee_timezone: process.env.TEAM_TIMEZONE ?? "America/New_York",
    }))
  );

  const { error } = await supabase.from("tasks").insert(taskInserts);

  if (error) {
    console.error("[voice] task insert failed:", error);
    await postThreadReply(
      channelId,
      threadTs,
      "⚠️ Task was understood but failed to save. Please try again."
    );
    return;
  }

  const assigneeMentions = matchedMembers.map(m => `<@${m.id}>`).join(", ");
  const isMultiTask = taskLines.length > 1;
  const doneInstruction = isMultiTask
    ? `Use *"Task 1 done"*, *"Task 2 done"*, etc. to mark each task complete. Use this thread for any questions.`
    : `please reply *"done"* in this thread when the task is complete. Use this thread for any questions.`;

  const voiceConfirmTs = await postThreadReply(
    channelId,
    threadTs,
    `✅ *Task assigned from voice note*\n\n` +
      `*Assigned to:* ${assigneeMentions}\n\n` +
      formatTaskBody(parsed.taskText) +
      `\n\n${assigneeMentions} — ${doneInstruction}`
  );
  await saveBotMessageTs(supabase, channelId, threadTs, voiceConfirmTs);

  console.log("[voice] tasks created for:", matchedMembers.map(m => m.name).join(", "), "task:", parsed.taskText.slice(0, 80));
}
