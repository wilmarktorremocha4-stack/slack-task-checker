import { NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase";
import { postThreadReply } from "@/lib/slack";
import { calculateNextFollowupAt } from "@/lib/followup-schedule";

export const runtime = "nodejs";

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

// PATCH — approve or cancel a task
export async function PATCH(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const supabase = createSupabaseAdmin();
  const { action } = (await request.json()) as { action: "approve" | "cancel" };

  const { data: task } = await supabase
    .from("tasks")
    .select("*")
    .eq("id", id)
    .single();

  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  if (action === "approve") {
    await supabase
      .from("tasks")
      .update({ status: "completed", completed_at: new Date().toISOString(), next_followup_at: null })
      .eq("id", id);

    await postThreadReply(
      task.channel_id,
      task.thread_ts,
      `✅ Brandon reviewed and approved this task. Well done ${task.assigned_to_name}!`
    );

    await supabase.from("task_comments").insert({
      task_id: id,
      author_type: "system",
      author_name: "System",
      content: "Task approved and marked complete by Brandon.",
      sent_to_slack: true,
    });
  } else if (action === "cancel") {
    await supabase
      .from("tasks")
      .update({ status: "cancelled", next_followup_at: null })
      .eq("id", id);

    await postThreadReply(
      task.channel_id,
      task.thread_ts,
      `This task has been cancelled by Brandon.`
    );

    await supabase.from("task_comments").insert({
      task_id: id,
      author_type: "system",
      author_name: "System",
      content: "Task cancelled by Brandon.",
      sent_to_slack: true,
    });
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

  const trimmed = content.trim();

  await supabase.from("task_comments").insert({
    task_id: id,
    author_type: "brandon",
    author_name: task.assigned_by_name,
    content: trimmed,
    sent_to_slack: true,
  });

  await postThreadReply(
    task.channel_id,
    task.thread_ts,
    `Hey ${task.assigned_to_name}, ${task.assigned_by_name} has reviewed your work and has some feedback:\n\n> ${trimmed}\n\nPlease address this and reply *"done"* in this thread when complete.`
  );

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
