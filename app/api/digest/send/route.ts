import { NextResponse } from "next/server";
import { createSupabaseAdmin, Task } from "@/lib/supabase";
import { getSlackClient } from "@/lib/slack";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST() {
  const supabase = createSupabaseAdmin();
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const { data: newTasks, error } = await supabase
    .from("tasks")
    .select("*")
    .gte("created_at", weekAgo.toISOString())
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[digest/send] DB error:", error);
    return NextResponse.json({ error: "Database error" }, { status: 500 });
  }

  const { data: completedOlder } = await supabase
    .from("tasks")
    .select("*")
    .eq("status", "completed")
    .gte("completed_at", weekAgo.toISOString());

  const seen = new Set((newTasks ?? []).map((t) => (t as Task).id));
  const extra = (completedOlder ?? []).filter((t) => !seen.has((t as Task).id));
  const all = [...(newTasks ?? []), ...extra] as Task[];

  const done      = all.filter((t) => t.status === "completed");
  const active    = all.filter((t) => t.status === "active");
  const revision  = all.filter((t) => t.status === "revision_requested");
  const cancelled = all.filter((t) => t.status === "cancelled");
  const total     = all.length;
  const pct       = total > 0 ? Math.round((done.length / total) * 100) : 0;

  const fmt = (d: Date) =>
    d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const dateRange = `${fmt(weekAgo)} – ${fmt(now)}`;

  const taskLine = (t: Task) => {
    const name  = t.assigned_to_name || t.assignee_names?.[0] || "Team";
    const emoji = t.status === "completed" ? "✅" : t.status === "revision_requested" ? "🔄" : "🔵";
    return `${emoji} *${t.task_text}*\n_${name} · ${t.followup_count}/${t.max_followups} follow-ups_`;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blocks: any[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `📅 Weekly Digest — ${dateRange}` },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: "Here's a summary of all tasks assigned to your team this week." },
    },
    { type: "divider" },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*🔵 Active*\n${active.length}` },
        { type: "mrkdwn", text: `*✅ Done*\n${done.length}` },
        { type: "mrkdwn", text: `*🔄 Revision*\n${revision.length}` },
        { type: "mrkdwn", text: `*❌ Cancelled*\n${cancelled.length}` },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Completion rate:* ${pct}% — ${done.length} of ${total} tasks completed`,
      },
    },
    { type: "divider" },
  ];

  if (done.length > 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*✅ Completed this week (${done.length})*` },
    });
    done.slice(0, 5).forEach((t) =>
      blocks.push({ type: "section", text: { type: "mrkdwn", text: taskLine(t) } })
    );
    if (done.length > 5)
      blocks.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: `_+ ${done.length - 5} more completed tasks_` }],
      });
    blocks.push({ type: "divider" });
  }

  const inProgress = [...active, ...revision];
  if (inProgress.length > 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*🔵 Still in progress (${inProgress.length})*` },
    });
    inProgress.slice(0, 5).forEach((t) =>
      blocks.push({ type: "section", text: { type: "mrkdwn", text: taskLine(t) } })
    );
    if (inProgress.length > 5)
      blocks.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: `_+ ${inProgress.length - 5} more active tasks_` }],
      });
    blocks.push({ type: "divider" });
  }

  const channelId = process.env.SLACK_CHANNEL_ID ?? "C070RSAKTTN";
  const fallbackText = `📅 Weekly Digest (${dateRange}): ${done.length} done · ${active.length} active · ${revision.length} revision · ${cancelled.length} cancelled`;

  try {
    const slack = getSlackClient();
    const result = await slack.chat.postMessage({
      channel: channelId,
      text: fallbackText,
      blocks,
    });

    await supabase.from("digest_logs").insert({
      triggered_by: "manual",
      date_range_start: weekAgo.toISOString(),
      date_range_end: now.toISOString(),
      total_tasks: total,
      done_count: done.length,
      active_count: active.length,
      revision_count: revision.length,
      cancelled_count: cancelled.length,
      completion_pct: pct,
      slack_message_ts: result.ts ?? null,
      message_preview: fallbackText.slice(0, 300),
    });

    return NextResponse.json({ ok: true, total, done: done.length, active: active.length });
  } catch (err) {
    console.error("[digest/send] Slack post failed:", err);
    return NextResponse.json({ error: "Failed to post to Slack" }, { status: 500 });
  }
}
