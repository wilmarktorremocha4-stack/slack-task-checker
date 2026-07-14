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
  // Search by thread_ts (catches all tasks in the thread, including ones created
  // by later thread commands) AND by message_ts as a fallback.
  const { data: byThread } = await supabase
    .from("tasks")
    .select("id, status, thread_ts, channel_id")
    .eq("thread_ts", deletedTs)
    .in("status", ["active", "revision_requested", "completed"]);

  const { data: byMessage } = await supabase
    .from("tasks")
    .select("id, status, thread_ts, channel_id")
    .eq("message_ts", deletedTs)
    .in("status", ["active", "revision_requested", "completed"]);

  const allTasks = [
    ...(byThread ?? []),
    ...(byMessage ?? []),
  ].filter((t, i, arr) => arr.findIndex((x) => x.id === t.id) === i);

  if (allTasks.length === 0) {
    console.log("[delete] no tasks found for ts:", deletedTs);
    return;
  }

  // Cancel all tasks in the DB
  const ids = allTasks.map((t) => t.id as string);
  await supabase
    .from("tasks")
    .update({ status: "cancelled", next_followup_at: null })
    .in("id", ids);

  console.log("[delete] cancelled", ids.length, "task(s) for deleted ts:", deletedTs);

  // Delete every bot message in the thread so there's no orphaned follow-up trail
  const resolvedChannelId = channelId || (allTasks[0]?.channel_id as string);
  if (!resolvedChannelId) return;

  try {
    const botUserId = await getBotUserId();
    const botEnvId = process.env.SLACK_BOT_USER_ID ?? "";
    const slack = getSlackClient();

    const replies = await slack.conversations.replies({
      channel: resolvedChannelId,
      ts: deletedTs,
      limit: 200,
    });

    const botMessages = (replies.messages ?? []).filter((m) => {
      const isBot = m.user === botUserId || m.user === botEnvId || !!m.bot_id;
      const isRoot = m.ts === deletedTs;
      return isBot && !isRoot; // don't try to delete the already-deleted root
    });

    console.log("[delete] deleting", botMessages.length, "bot message(s) from thread");

    await Promise.all(
      botMessages.map((m) =>
        slack.chat.delete({ channel: resolvedChannelId, ts: m.ts! }).catch((err) => {
          console.error("[delete] failed to delete message ts:", m.ts, err?.data?.error);
        })
      )
    );
  } catch (err) {
    // Thread may already be gone — log and continue
    console.error("[delete] error fetching/deleting thread messages:", err);
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
    await postThreadReply(
      channelId,
      threadTs,
      "Hey! To assign a task, mention me and tag the person: `@Task Bot @teammate task description here`"
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

  let parsed: { taskText: string; hasTask: boolean } | null = null;
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

  const nextFollowupAt = calculateNextFollowupAt(0, new Date(), process.env.TEAM_TIMEZONE ?? "UTC");
  console.log("[task] step 6 — inserting task into supabase, nextFollowupAt:", nextFollowupAt);

  const { data, error } = await supabase
    .from("tasks")
    .insert({
      task_text: parsed.taskText,
      raw_message: messageText,
      assigned_to_id: primaryAssignee.id,
      assigned_to_name: primaryAssignee.name,
      assignee_ids: assignees.map(a => a.id),
      assignee_names: assignees.map(a => a.name),
      assigned_by_id: senderId,
      assigned_by_name: assignerName,
      channel_id: channelId,
      message_ts: messageTs,
      thread_ts: threadTs,
      status: "active",
      followup_count: 0,
      max_followups: 5,
      next_followup_at: nextFollowupAt?.toISOString() ?? null,
      assignee_timezone: process.env.TEAM_TIMEZONE ?? "UTC",
    })
    .select()
    .single();

  if (error) {
    console.error("[task] step 6 failed — supabase insert error:", JSON.stringify(error));
    return;
  }

  console.log("[task] step 7 — task saved, id:", data?.id, "posting confirmation");

  const allMentions = assignees.map(a => `<@${a.id}>`).join(", ");

  await postThreadReply(
    channelId,
    threadTs,
    `✅ *Task assigned*\n\n*Assigned to:* ${allMentions}\n\n` +
      formatTaskBody(parsed.taskText) +
      `\n\n${allMentions} — please reply *"done"* in this thread when the task is complete. Use this thread for any questions.`
  );

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
    const replyMentions = [...rawReplyText.matchAll(/<@([A-Z0-9]+)>/g)]
      .map(m => m[1])
      .filter(id => id !== process.env.SLACK_BRANDON_USER_ID);

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
        process.env.TEAM_TIMEZONE ?? "UTC"
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
        assignee_timezone: process.env.TEAM_TIMEZONE ?? "UTC",
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

  const assigneeIds: string[] = task.assignee_ids?.length ? task.assignee_ids : [task.assigned_to_id];
  const isAssignee = assigneeIds.includes(userId);
  const isOpen = task.status === "active" || task.status === "revision_requested";

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
      (t) => (t.assignee_ids?.includes(userId) || t.assigned_to_id === userId)
    );
    const targetTask = myTasks[taskIndex];
    if (targetTask && (targetTask.status === "active" || targetTask.status === "revision_requested")) {
      await supabase.from("tasks").update({ status: "completed", completed_at: new Date().toISOString(), next_followup_at: null }).eq("id", targetTask.id);
      await postThreadReply(
        targetTask.channel_id,
        targetTask.thread_ts,
        `🎉 Got it ${targetTask.assigned_to_name}! *Task ${taskIndex + 1}* marked as done:\n> ${targetTask.task_text}\n\nI've stopped follow-ups for this one.`
      );
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

    await postThreadReply(
      taskToComplete.channel_id,
      taskToComplete.thread_ts,
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
    const assigneeNames = (task.assignee_names?.length
      ? task.assignee_names
      : [task.assigned_to_name]) as string[];
    await postThreadReply(
      task.channel_id,
      task.thread_ts,
      `Hey <@${userId}>, you're not assigned to this task — only ${assigneeNames.map(n => `*${n}*`).join(" and ")} can mark it as done. You might be in the wrong thread!`
    );
    return;
  }

  // Log every other human reply for full thread visibility on the dashboard
  if (rawText.length > 0) {
    const authorName = isAssignee ? task.assigned_to_name : await getSlackUserName(userId);
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

  // Active tasks for command context (reassign, add, etc.)
  const activeThreadTasks = threadTasks.filter(
    (t) => t.status !== "cancelled" && t.status !== "escalated"
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
  const isSummaryRequest = /\b(what (are|is)|list|show|summary|status of).*task|task.*(list|status|summary|what)/i.test(textContent);
  if (isSummaryRequest) {
    const allThreadTasks = await supabase
      .from("tasks")
      .select("*")
      .eq("thread_ts", threadTs)
      .order("created_at", { ascending: true });

    const tasks = allThreadTasks.data ?? [];
    if (tasks.length === 0) {
      await postThreadReply(channelId, threadTs, "No tasks found in this thread.");
      return;
    }

    const lines = tasks.map((t, i) => {
      const icon = t.status === "completed" ? "✅" : t.status === "cancelled" ? "🗑️" : "🔵";
      const assignee = `<@${t.assigned_to_id}>`;
      const status = t.status === "completed" ? "Done" : t.status === "cancelled" ? "Cancelled" : `Active · ${t.followup_count}/5 follow-ups sent`;
      return `${icon} *Task ${i + 1}:* ${t.task_text}\n   *Assigned to:* ${assignee} · *Status:* ${status}`;
    });
    await postThreadReply(channelId, threadTs, `📋 *Tasks in this thread:*\n\n${lines.join("\n\n")}`);
    return;
  }

  console.log("[thread-cmd] parsing command:", humanText.slice(0, 150));

  const command = await parseThreadCommand({
    messageText: humanText,
    existingTaskText,
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

  const nextFollowupAt = calculateNextFollowupAt(0, new Date(), process.env.TEAM_TIMEZONE ?? "UTC");

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

    const inserts = newMembers.map((member) => ({
      task_text: existingTaskText,
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
      assignee_timezone: process.env.TEAM_TIMEZONE ?? "UTC",
    }));

    await supabase.from("tasks").insert(inserts);

    const addedMentions = newMembers.map((m) => `<@${m.id}>`).join(", ");
    await postThreadReply(
      channelId,
      threadTs,
      `✅ Added ${addedMentions} to this task.\n\n${addedMentions} — please reply *"done"* in this thread when complete. Use this thread for any questions.`
    );
    console.log("[thread-cmd] add_assignee:", newMembers.map((m) => m.name).join(", "));
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
    await supabase
      .from("tasks")
      .update({ status: "cancelled" })
      .eq("thread_ts", threadTs)
      .in("assigned_to_id", removeIds);

    const removedMentions = toRemove.map((m) => `<@${m.id}>`).join(", ");
    await postThreadReply(channelId, threadTs, `🗑️ Removed ${removedMentions} from this task.`);
    console.log("[thread-cmd] remove_assignee:", toRemove.map((m) => m.name).join(", "));
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

    // Only create new tasks for people NOT already assigned
    const newMembers = toAdd.filter((m) => !alreadyAssignedIds.has(m.id));
    if (newMembers.length > 0) {
      const inserts = newMembers.map((member) => ({
        task_text: existingTaskText,
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
        assignee_timezone: process.env.TEAM_TIMEZONE ?? "UTC",
      }));
      await supabase.from("tasks").insert(inserts);
    }

    const newMentions = toAdd.map((m) => `<@${m.id}>`).join(", ");
    await postThreadReply(
      channelId,
      threadTs,
      `✅ Reassigned to ${newMentions}.\n\n${newMentions} — please reply *"done"* in this thread when complete. Use this thread for any questions.`
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
      assignee_timezone: process.env.TEAM_TIMEZONE ?? "UTC",
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

    const nextFollowupAt2 = calculateNextFollowupAt(0, new Date(), process.env.TEAM_TIMEZONE ?? "UTC");
    const idsToReopen = [...new Set(closedTasks.map((t) => t.id as string))];
    await supabase.from("tasks").update({
      status: "active",
      completed_at: null,
      next_followup_at: nextFollowupAt2?.toISOString() ?? null,
      followup_count: 0,
    }).in("id", idsToReopen);

    const assigneeMentions = [...new Set(closedTasks.map((t) => t.assigned_to_id as string))]
      .map((id) => `<@${id}>`).join(", ");
    await postThreadReply(
      channelId,
      threadTs,
      `🔁 Task reopened and follow-ups restarted.\n\n*Assigned to:* ${assigneeMentions}\n\n${formatTaskBody(closedTasks[0].task_text as string)}\n\n${assigneeMentions} — please reply *"done"* when complete.`
    );
    console.log("[thread-cmd] reopen_task — reopened", idsToReopen.length, "task(s)");
    return;
  }

  // ── CANCEL TASK ───────────────────────────────────────────────────────────
  if (command.intent === "cancel_task") {
    const existingIds = activeThreadTasks.map((t) => t.id as string);
    await supabase.from("tasks").update({ status: "cancelled", next_followup_at: null }).in("id", existingIds);
    await postThreadReply(
      channelId,
      threadTs,
      `🗑️ Got it — task cancelled. No further follow-ups will be sent.\n\nIf you need to assign a new task, just @mention me here with the details.`
    );
    console.log("[thread-cmd] cancel_task — cancelled", existingIds.length, "task(s)");
    return;
  }

  // ── CANCEL AND REPLACE ────────────────────────────────────────────────────
  if (command.intent === "cancel_and_replace") {
    const newText = command.newTaskText?.trim();
    if (!newText) {
      await postThreadReply(channelId, threadTs, "I cancelled the old task but couldn't figure out the new one. What should the new task be?");
      // Cancel anyway
      const existingIds = threadTasks.map((t) => t.id as string);
      await supabase.from("tasks").update({ status: "cancelled", next_followup_at: null }).in("id", existingIds);
      return;
    }

    // Cancel existing tasks
    const existingIds = threadTasks.map((t) => t.id as string);
    await supabase.from("tasks").update({ status: "cancelled", next_followup_at: null }).in("id", existingIds);

    // Determine assignees, honouring thread history:
    // - keepExistingAssignees=true ("add also @Harry") → keep Makoy + add Harry
    // - explicit new names only ("replace with @Harry") → only Harry
    // - no names mentioned → keep existing unchanged
    const namedAssignees = resolveMembers(command.addNames, mentionedIds);
    const existingAssignees = [...new Set(threadTasks.map((t) => t.assigned_to_id as string))].map((id) => {
      const t = threadTasks.find((x) => x.assigned_to_id === id)!;
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
      assignee_timezone: process.env.TEAM_TIMEZONE ?? "UTC",
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
      const nextFollowupAt2 = calculateNextFollowupAt(0, new Date(), process.env.TEAM_TIMEZONE ?? "UTC");
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
        assignee_timezone: process.env.TEAM_TIMEZONE ?? "UTC",
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
    .not("status", "in", '("cancelled","escalated")')
    .order("created_at", { ascending: true });

  const teamMembers = await getWorkspaceMembers();

  // No existing tasks — treat the voice note as a new task creation
  if (!threadTasks || threadTasks.length === 0) {
    console.log("[voice-thread] no existing tasks in thread — creating new task from voice");
    await handleVoiceMessage(event, audioFile, supabase, brandonUserId);
    return;
  }

  const existingTaskText = threadTasks[0].task_text as string;
  const existingAssigneeNames: string[] = [
    ...new Set(threadTasks.flatMap((t) => (t.assignee_names?.length ? t.assignee_names : [t.assigned_to_name]) as string[])),
  ];

  // ── Parse the transcription as a thread command ───────────────────────────
  const command = await parseThreadCommand({
    messageText: transcription,
    existingTaskText,
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
  const nextFollowupAt = calculateNextFollowupAt(0, new Date(), process.env.TEAM_TIMEZONE ?? "UTC");

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
    const alreadyIds = new Set(threadTasks.map((t) => t.assigned_to_id as string));
    const newMembers = toAdd.filter((m) => !alreadyIds.has(m.id));
    if (newMembers.length === 0) {
      await postThreadReply(channelId, threadTs, `${toAdd.map((m) => `<@${m.id}>`).join(", ")} ${toAdd.length === 1 ? "is" : "are"} already assigned to this task.`);
      return;
    }
    await supabase.from("tasks").insert(newMembers.map((member) => ({
      task_text: existingTaskText,
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
      assignee_timezone: process.env.TEAM_TIMEZONE ?? "UTC",
    })));
    const addedMentions = newMembers.map((m) => `<@${m.id}>`).join(", ");
    await postThreadReply(channelId, threadTs, `✅ Added ${addedMentions} to this task.\n\n${addedMentions} — please reply *"done"* in this thread when complete.`);
    return;
  }

  // ── REMOVE ASSIGNEE ───────────────────────────────────────────────────────
  if (command.intent === "remove_assignee") {
    const toRemove = resolveMembers(command.removeNames);
    if (toRemove.length === 0) {
      await postThreadReply(channelId, threadTs, "I couldn't figure out who to remove from the voice note. Please @mention them in a text reply.");
      return;
    }
    await supabase
      .from("tasks")
      .update({ status: "cancelled" })
      .eq("thread_ts", threadTs)
      .in("assigned_to_id", toRemove.map((m) => m.id));
    await postThreadReply(channelId, threadTs, `🗑️ Removed ${toRemove.map((m) => `<@${m.id}>`).join(", ")} from this task.`);
    return;
  }

  // ── REASSIGN ──────────────────────────────────────────────────────────────
  if (command.intent === "reassign") {
    const toAdd = resolveMembers(command.addNames);
    if (toAdd.length === 0) {
      await postThreadReply(channelId, threadTs, "I couldn't figure out who to reassign to from the voice note. Please @mention them in a text reply.");
      return;
    }

    const alreadyAssignedIds = new Set(threadTasks.map((t) => t.assigned_to_id as string));
    const toAddIds = new Set(toAdd.map((m) => m.id));

    // Cancel tasks for people NOT in the new assignee list
    const tasksToCancel = threadTasks.filter((t) => !toAddIds.has(t.assigned_to_id as string));
    if (tasksToCancel.length > 0) {
      await supabase.from("tasks").update({ status: "cancelled", next_followup_at: null }).in("id", tasksToCancel.map((t) => t.id as string));
    }

    // Only create new tasks for people NOT already assigned
    const newMembers = toAdd.filter((m) => !alreadyAssignedIds.has(m.id));
    if (newMembers.length > 0) {
      await supabase.from("tasks").insert(newMembers.map((member) => ({
        task_text: existingTaskText,
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
        assignee_timezone: process.env.TEAM_TIMEZONE ?? "UTC",
      })));
    }

    const newMentions = toAdd.map((m) => `<@${m.id}>`).join(", ");
    await postThreadReply(channelId, threadTs, `✅ Reassigned to ${newMentions}.\n\n${newMentions} — please reply *"done"* in this thread when complete.`);
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
      assignees = [...new Set(threadTasks.map((t) => t.assigned_to_id as string))].map((id) => {
        const t = threadTasks.find((x) => x.assigned_to_id === id)!;
        return { id, name: t.assigned_to_name as string };
      });
    }
    for (const m of resolveMembers(command.addNames)) {
      if (!assignees.find((a) => a.id === m.id)) assignees.push(m);
    }
    if (assignees.length === 0) {
      // Default to current thread assignees rather than asking
      assignees = [...new Set(threadTasks.map((t) => t.assigned_to_id as string))].map((id) => {
        const t = threadTasks.find((x) => x.assigned_to_id === id)!;
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
      assignee_timezone: process.env.TEAM_TIMEZONE ?? "UTC",
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

    const nextFollowupAt2 = calculateNextFollowupAt(0, new Date(), process.env.TEAM_TIMEZONE ?? "UTC");
    const idsToReopen = [...new Set(closedTasks.map((t) => t.id as string))];
    await supabase.from("tasks").update({
      status: "active",
      completed_at: null,
      next_followup_at: nextFollowupAt2?.toISOString() ?? null,
      followup_count: 0,
    }).in("id", idsToReopen);

    const assigneeMentions = [...new Set(closedTasks.map((t) => t.assigned_to_id as string))]
      .map((id) => `<@${id}>`).join(", ");
    await postThreadReply(
      channelId,
      threadTs,
      `🔁 Task reopened and follow-ups restarted.\n\n*Assigned to:* ${assigneeMentions}\n\n${formatTaskBody(closedTasks[0].task_text as string)}\n\n${assigneeMentions} — please reply *"done"* when complete.`
    );
    console.log("[voice-thread] reopen_task — reopened", idsToReopen.length, "task(s)");
    return;
  }

  // ── CANCEL TASK ───────────────────────────────────────────────────────────
  if (command.intent === "cancel_task") {
    await supabase.from("tasks").update({ status: "cancelled", next_followup_at: null }).in("id", threadTasks.map((t) => t.id as string));
    await postThreadReply(channelId, threadTs, `🗑️ Got it — task cancelled. No further follow-ups will be sent.`);
    return;
  }

  // ── CANCEL AND REPLACE ────────────────────────────────────────────────────
  if (command.intent === "cancel_and_replace") {
    const newText = command.newTaskText?.trim();
    await supabase.from("tasks").update({ status: "cancelled", next_followup_at: null }).in("id", threadTasks.map((t) => t.id as string));
    if (!newText) {
      await postThreadReply(channelId, threadTs, "I cancelled the old task but couldn't catch the new one. What should the new task be?");
      return;
    }
    const namedAssignees = resolveMembers(command.addNames);
    const existingAssignees = [...new Set(threadTasks.map((t) => t.assigned_to_id as string))].map((id) => {
      const t = threadTasks.find((x) => x.assigned_to_id === id)!;
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
      assignee_timezone: process.env.TEAM_TIMEZONE ?? "UTC",
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

  await postThreadReply(
    channelId,
    threadTs,
    "🎙️ Got your voice note! Transcribing now..."
  );

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
      `📝 Here's what I heard:\n\n_"${transcription}"_\n\nI couldn't identify a clear task here. Could you clarify what needs to be done and who should do it?`
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

    await postThreadReply(
      channelId,
      threadTs,
      `📝 Transcribed your voice note!\n\n*Task:* ${parsed.summary}\n\n` +
        `<@${brandonUserId}> — who should this be assigned to? ` +
        `Please @mention them in a reply here and I'll create the task automatically.`
    );
    return;
  }

  // Create tasks for all matched assignees
  const assignerName = await getSlackUserName(senderId);
  const nextFollowupAt = calculateNextFollowupAt(
    0,
    new Date(),
    process.env.TEAM_TIMEZONE ?? "UTC"
  );

  const taskInserts = matchedMembers.map(member => ({
    task_text: parsed.taskText,
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
    assignee_timezone: process.env.TEAM_TIMEZONE ?? "UTC",
  }));

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

  await postThreadReply(
    channelId,
    threadTs,
    `✅ *Task assigned from voice note*\n\n` +
      `*Assigned to:* ${assigneeMentions}\n\n` +
      formatTaskBody(parsed.taskText) +
      `\n\n${assigneeMentions} — please reply *"done"* in this thread when the task is complete. Use this thread for any questions.`
  );

  console.log("[voice] tasks created for:", matchedMembers.map(m => m.name).join(", "), "task:", parsed.taskText.slice(0, 80));
}
