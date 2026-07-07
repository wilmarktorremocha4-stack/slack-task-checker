import { NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase";
import { postThreadReply, postColoredMessage, slackMention } from "@/lib/slack";
import { calculateNextFollowupAt } from "@/lib/followup-schedule";
import { sendFollowupForTask } from "@/lib/followup-engine";

export const runtime = "nodejs";
export const maxDuration = 30;

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: RouteContext) {
  const { id } = await params;
  const supabase = createSupabaseAdmin();

  const { data: task, error } = await supabase
    .from("tasks")
    .select("*, task_comments(*)")
    .eq("id", id)
    .single();

  if (error || !task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  return NextResponse.json({ task });
}

// PATCH — approve, cancel, or push an immediate follow-up
export async function PATCH(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const supabase = createSupabaseAdmin();
  const { action, content } = (await request.json()) as {
    action: "approve" | "cancel" | "followup_now" | "reopen";
    content?: string;
  };

  const { data: task } = await supabase
    .from("tasks")
    .select("*")
    .eq("id", id)
    .single();

  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  if (action === "approve") {
    if (task.status === "completed" || task.status === "cancelled") {
      return NextResponse.json({ error: "Task is already closed" }, { status: 409 });
    }

    const assigneeIds: string[] = task.assignee_ids?.length ? task.assignee_ids : [task.assigned_to_id];
    const mentions = assigneeIds.map((uid: string) => slackMention(uid)).join(" ");

    // If manager typed a message, post it to Slack first before the approval notice
    if (content?.trim()) {
      await postColoredMessage(
        task.channel_id,
        task.thread_ts,
        "#3B82F6",
        `${mentions} ${task.assigned_by_name}: ${content.trim()}`
      );
      await supabase.from("task_comments").insert({
        task_id: id,
        author_type: "brandon",
        author_name: task.assigned_by_name,
        content: content.trim(),
        sent_to_slack: true,
      });
    }

    await supabase
      .from("tasks")
      .update({ status: "completed", completed_at: new Date().toISOString(), next_followup_at: null })
      .eq("id", id);

    await postThreadReply(
      task.channel_id,
      task.thread_ts,
      `✅ ${mentions} ${task.assigned_by_name} reviewed and approved this task. Well done!`
    );

    await supabase.from("task_comments").insert({
      task_id: id,
      author_type: "system",
      author_name: "System",
      content: `Task approved and closed by ${task.assigned_by_name}.`,
      sent_to_slack: true,
    });
  } else if (action === "cancel") {
    if (task.status === "completed" || task.status === "cancelled") {
      return NextResponse.json({ error: "Task is already closed" }, { status: 409 });
    }

    await supabase
      .from("tasks")
      .update({ status: "cancelled", next_followup_at: null })
      .eq("id", id);

    await postThreadReply(
      task.channel_id,
      task.thread_ts,
      `${slackMention(task.assigned_to_id)} this task has been cancelled by ${task.assigned_by_name}. No further action needed.`
    );

    await supabase.from("task_comments").insert({
      task_id: id,
      author_type: "system",
      author_name: "System",
      content: `Task cancelled by ${task.assigned_by_name}.`,
      sent_to_slack: true,
    });
  } else if (action === "reopen") {
    if (task.status === "active" || task.status === "revision_requested") {
      return NextResponse.json({ error: "Task is already open" }, { status: 409 });
    }

    const nextFollowupAt = calculateNextFollowupAt(0);

    await supabase
      .from("tasks")
      .update({
        status: "active",
        followup_count: 0,
        next_followup_at: nextFollowupAt?.toISOString() ?? null,
        completed_at: null,
        escalated_at: null,
      })
      .eq("id", id);

    await postThreadReply(
      task.channel_id,
      task.thread_ts,
      `${slackMention(task.assigned_to_id)} this task has been reopened by ${task.assigned_by_name}:\n> ${task.task_text}\n\nReply *"done"* in this thread when it's complete.`,
      { broadcast: true }
    );

    await supabase.from("task_comments").insert({
      task_id: id,
      author_type: "system",
      author_name: "System",
      content: `Task reopened by ${task.assigned_by_name}. Follow-up schedule restarted.`,
      sent_to_slack: true,
    });
  } else if (action === "followup_now") {
    if (task.status !== "active" && task.status !== "revision_requested") {
      return NextResponse.json(
        { error: "Follow-ups can only be sent for open tasks" },
        { status: 409 }
      );
    }

    try {
      const result = await sendFollowupForTask(supabase, task, { manual: true });
      return NextResponse.json({ ok: true, result });
    } catch (err) {
      console.error(`[followup_now] failed for task ${id}:`, err);
      return NextResponse.json({ error: "Failed to send follow-up to Slack" }, { status: 502 });
    }
  } else {
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}

// POST — Brandon adds a revision comment (reopens task + sends to Slack)
export async function POST(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const supabase = createSupabaseAdmin();
  const { content } = (await request.json()) as { content: string };

  if (!content?.trim()) {
    return NextResponse.json({ error: "Comment cannot be empty" }, { status: 400 });
  }

  const { data: task } = await supabase
    .from("tasks")
    .select("*")
    .eq("id", id)
    .single();

  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  if (task.status === "cancelled") {
    return NextResponse.json({ error: "Task is cancelled" }, { status: 409 });
  }

  const trimmed = content.trim();

  // Real <@id> mention (notifies the assignee) + broadcast so the reply is
  // also visible in the main channel, not buried inside the thread.
  try {
    await postThreadReply(
      task.channel_id,
      task.thread_ts,
      `${slackMention(task.assigned_to_id)} ${task.assigned_by_name} reviewed your work and needs some changes:\n\n> ${trimmed}\n\nPlease address this and reply *"done"* in this thread when complete.`,
      { broadcast: true }
    );
  } catch (err) {
    console.error(`[revision] Slack post failed for task ${id}:`, err);
    return NextResponse.json(
      { error: "Could not deliver the revision to Slack — nothing was changed. Please try again." },
      { status: 502 }
    );
  }

  await supabase.from("task_comments").insert({
    task_id: id,
    author_type: "brandon",
    author_name: task.assigned_by_name,
    content: trimmed,
    sent_to_slack: true,
  });

  const nextFollowupAt = calculateNextFollowupAt(0);

  await supabase
    .from("tasks")
    .update({
      status: "revision_requested",
      followup_count: 0,
      next_followup_at: nextFollowupAt?.toISOString() ?? null,
      completed_at: null,
    })
    .eq("id", id);

  await supabase.from("task_comments").insert({
    task_id: id,
    author_type: "system",
    author_name: "System",
    content: "Task reopened with revision request. Follow-up schedule restarted.",
    sent_to_slack: false,
  });

  return NextResponse.json({ ok: true });
}
