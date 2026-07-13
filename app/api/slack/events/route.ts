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

  // ── CASE 0: File/audio message uploaded ─────────────────────────────────────
  if (
    event.type === "message" &&
    event.files &&
    Array.isArray(event.files) &&
    event.files.length > 0 &&
    event.channel === monitoredChannelId &&
    !event.thread_ts
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
      console.log("[voice] audio file detected:", audioFile.name);
      await handleVoiceMessage(event, audioFile, supabase, brandonUserId);
      return;
    }
  }

  const isMention = event.type === "app_mention";
  const channelMatch = event.channel === monitoredChannelId;
  const noThread = !event.thread_ts;

  if (isMention && channelMatch && noThread) {
    console.log("[slack] → new task mention");
    await handleNewTaskMention(event, supabase, brandonUserId);
    return;
  }

  // Bot @mentioned inside an existing thread — treat as a thread command
  if (isMention && channelMatch && event.thread_ts) {
    console.log("[slack] → bot mentioned in thread");
    await handleBotMentionInThread(event, supabase, brandonUserId);
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
      "Hey! To assign a task, mention me and tag the person: `@TaskBot @teammate task description here`"
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
      `Got it ${assignerName}! But I couldn't identify a clear task. Try: \`@TaskBot @${primaryAssignee.name} needs to [specific task description]\``
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

  // Bullet task lines if multiple
  const taskLines = parsed.taskText
    .split(/\n|;/)
    .map((l: string) => l.trim())
    .filter(Boolean);
  const taskBody =
    taskLines.length > 1
      ? taskLines.map((l: string) => `• ${l}`).join("\n")
      : `• ${parsed.taskText}`;

  await postThreadReply(
    channelId,
    threadTs,
    `✅ *Task assigned*\n\n*Assigned to:* ${allMentions}\n\n` +
      taskBody +
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

    if (replyMentions.length > 0) {
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
        `✅ *Task assigned*\n\n*Assigned to:* ${assigneeMentions}\n\n• ${pendingVoice.task_text}\n\n` +
          `${assigneeMentions} — please reply *"done"* in this thread when the task is complete. Use this thread for any questions.`
      );

      console.log("[voice] pending task resolved, assigned to:", matchedMembers.map(m => m.name).join(", "));
      return;
    }
  }

  // Match the task for this thread regardless of status
  const { data: task } = await supabase
    .from("tasks")
    .select("*")
    .eq("thread_ts", threadTs)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!task) {
    console.log("[reply] no task found for this thread");
    return;
  }

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
      `🎉 Great work ${task.assigned_to_name}! Task marked as *done*:\n> ${task.task_text}\n\nNice one — I've stopped the follow-ups.`
    );

    await supabase.from("task_comments").insert([
      {
        task_id: task.id,
        author_type: "assignee",
        author_name: task.assigned_to_name,
        content: rawText,
        sent_to_slack: false,
      },
      {
        task_id: task.id,
        author_type: "system",
        author_name: "System",
        content: `${task.assigned_to_name} marked this task as done.`,
        sent_to_slack: true,
      },
    ]);

    const brandonUserId = process.env.SLACK_BRANDON_USER_ID!;
    await sendDirectMessage(
      brandonUserId,
      `✅ *Task Completed*\n\n*Assignee:* ${task.assigned_to_name}\n*Task:* ${task.task_text}\n\nThis task has been marked as done.`
    );

    console.log("[reply] task marked completed:", task.id);
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

  // Fetch all active tasks in this thread
  const { data: threadTasks } = await supabase
    .from("tasks")
    .select("*")
    .eq("thread_ts", threadTs)
    .not("status", "in", '("cancelled","escalated")')
    .order("created_at", { ascending: true });

  // No existing tasks in thread — fall through to new task creation
  if (!threadTasks || threadTasks.length === 0) {
    console.log("[thread-cmd] no existing tasks, delegating to new task handler");
    await handleNewTaskMention(event, supabase, brandonUserId);
    return;
  }

  const teamMembers = await getWorkspaceMembers();
  const existingTaskText = threadTasks[0].task_text as string;
  const existingAssigneeNames: string[] = [
    ...new Set(threadTasks.flatMap((t) => (t.assignee_names?.length ? t.assignee_names : [t.assigned_to_name]) as string[])),
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

  console.log("[thread-cmd] parsing command:", humanText.slice(0, 150));

  const command = await parseThreadCommand({
    messageText: humanText,
    existingTaskText,
    existingAssigneeNames,
    teamMemberNames: teamMembers.map((m) => m.name),
  });

  if (!command || command.intent === "unknown") {
    await postThreadReply(
      channelId,
      threadTs,
      `Not sure what you'd like me to do. Here's what I can handle in a task thread:\n` +
        `• *Add someone:* "add @Person to this task"\n` +
        `• *Remove someone:* "remove @Person from this task"\n` +
        `• *Reassign:* "reassign this only to @Person"\n` +
        `• *New task:* "add another task: [description]"`
    );
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
    const alreadyIds = new Set(threadTasks.map((t) => t.assigned_to_id as string));
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

    // Cancel all existing tasks in thread
    const existingIds = threadTasks.map((t) => t.id as string);
    await supabase.from("tasks").update({ status: "cancelled" }).in("id", existingIds);

    // Create new tasks for new assignees
    const inserts = toAdd.map((member) => ({
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
          threadTasks.map((t) => t.assigned_to_id as string)
        ),
      ].map((id) => {
        const t = threadTasks.find((x) => x.assigned_to_id === id)!;
        return { id, name: t.assigned_to_name as string };
      });
    }
    // Supplement or replace with explicitly named people
    const namedAssignees = resolveMembers(command.addNames, mentionedIds);
    for (const m of namedAssignees) {
      if (!assignees.find((a) => a.id === m.id)) assignees.push(m);
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
    // Bullet the new task lines
    const taskLines = newText.split(/\n|;/).map((l) => l.trim()).filter(Boolean);
    const taskBody = taskLines.length > 1
      ? taskLines.map((l) => `• ${l}`).join("\n")
      : `• ${newText}`;

    await postThreadReply(
      channelId,
      threadTs,
      `✅ *New task added*\n\n*Assigned to:* ${taskMentions}\n\n${taskBody}\n\n${taskMentions} — please reply *"done"* in this thread when complete. Use this thread for any questions.`
    );
    console.log("[thread-cmd] add_task for:", assignees.map((m) => m.name).join(", "), "task:", newText.slice(0, 80));
    return;
  }

  // ── CANCEL TASK ───────────────────────────────────────────────────────────
  if (command.intent === "cancel_task") {
    const existingIds = threadTasks.map((t) => t.id as string);
    await supabase.from("tasks").update({ status: "cancelled", next_followup_at: null }).in("id", existingIds);
    await postThreadReply(
      channelId,
      threadTs,
      `🗑️ Got it — I've cancelled and removed that task. No further follow-ups will be sent.\n\nIf you need to assign a new task, just @mention me here with the corrected details.`
    );
    console.log("[thread-cmd] cancel_task — cancelled", existingIds.length, "task(s)");
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

  const matchedMembers: Array<{ id: string; name: string }> = [];

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

  // Bullet the task lines if there are multiple (split on newlines or semicolons)
  const taskLines = parsed.taskText
    .split(/\n|;/)
    .map(l => l.trim())
    .filter(Boolean);
  const taskBody =
    taskLines.length > 1
      ? taskLines.map(l => `• ${l}`).join("\n")
      : `• ${parsed.taskText}`;

  await postThreadReply(
    channelId,
    threadTs,
    `✅ *Task assigned from voice note*\n\n` +
      `*Assigned to:* ${assigneeMentions}\n\n` +
      taskBody +
      `\n\n${assigneeMentions} — please reply *"done"* in this thread when the task is complete. Use this thread for any questions.`
  );

  console.log("[voice] tasks created for:", matchedMembers.map(m => m.name).join(", "), "task:", parsed.taskText.slice(0, 80));
}
