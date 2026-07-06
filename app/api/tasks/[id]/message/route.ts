import { NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase";
import { postThreadReply, slackMention } from "@/lib/slack";

export const runtime = "nodejs";
export const maxDuration = 30;

type RouteContext = { params: Promise<{ id: string }> };

// POST — Brandon sends a plain message to the Slack thread from the dashboard.
// Does NOT change the task status or the follow-up schedule.
export async function POST(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const supabase = createSupabaseAdmin();
  const { content } = (await request.json()) as { content: string };

  if (!content?.trim()) {
    return NextResponse.json({ error: "Message cannot be empty" }, { status: 400 });
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

  try {
    await postThreadReply(
      task.channel_id,
      task.thread_ts,
      `${slackMention(task.assigned_to_id)} message from ${task.assigned_by_name}:\n\n> ${trimmed}`
    );
  } catch (err) {
    console.error(`[message] Slack post failed for task ${id}:`, err);
    return NextResponse.json(
      { error: "Could not deliver the message to Slack. Please try again." },
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

  return NextResponse.json({ ok: true });
}
