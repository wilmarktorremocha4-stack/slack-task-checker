import OpenAI from "openai";
import { createPersonalSupabaseAdmin, Idea } from "./supabase-personal";
import { postToThread, postToChannel } from "./companion-slack";
import { JARVIS_SYSTEM_PROMPT } from "./companion-persona";

let _openai: OpenAI | null = null;
function openai() {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

function calculateNextReminder(
  frequencyHours: number,
  from: Date = new Date()
): Date {
  const next = new Date(from.getTime() + frequencyHours * 60 * 60 * 1000);
  const timezone = process.env.TEAM_TIMEZONE ?? "America/New_York";
  const localDay = new Date(
    next.toLocaleString("en-US", { timeZone: timezone })
  ).getDay();
  if (localDay === 6) next.setTime(next.getTime() + 2 * 24 * 60 * 60 * 1000);
  else if (localDay === 0) next.setTime(next.getTime() + 24 * 60 * 60 * 1000);
  return next;
}

async function generateSmartReminder(idea: Idea): Promise<string> {
  try {
    const response = await openai().chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `${JARVIS_SYSTEM_PROMPT}

You are sending a follow-up reminder about an idea Brandon captured.
Write a short, natural reminder — 1-2 sentences maximum.
Vary the phrasing each time — never send the same message twice.
Reference the specific idea content. Be Jarvis — precise, not robotic.
Never say "Reminder #X" or mention counts.
End with a one-line prompt to take action or update the status.`,
        },
        {
          role: "user",
          content: `Remind Brandon about this idea:
Title: ${idea.title}
Summary: ${idea.summary ?? idea.raw_input}
Category: ${idea.category}
Priority: ${idea.priority}
Created: ${new Date(idea.created_at).toLocaleDateString()}
Reminders sent so far: ${idea.reminder_count}
${idea.due_date ? `Due: ${new Date(idea.due_date).toLocaleDateString()}` : ""}
${idea.action_steps?.length ? `Action steps: ${idea.action_steps.join(", ")}` : ""}`,
        },
      ],
      max_tokens: 150,
      temperature: 0.8,
    });

    return (
      response.choices[0]?.message?.content?.trim() ??
      `Checking in on "${idea.title}" — any progress or updates?`
    );
  } catch {
    return `Quick check-in on "${idea.title}" — where does this stand?`;
  }
}

export async function processReminders(): Promise<{
  processed: number;
  results: Array<{ idea_id: string; title: string; action: string }>;
}> {
  const supabase = createPersonalSupabaseAdmin();
  const now = new Date();
  const channelId = process.env.SLACK_CHANNEL_ID!;

  const { data: dueIdeas } = await supabase
    .from("ideas")
    .select("*")
    .in("status", ["Active", "In Progress"])
    .eq("reminders_paused", false)
    .lte("next_reminder_at", now.toISOString())
    .not("next_reminder_at", "is", null);

  if (!dueIdeas || dueIdeas.length === 0) {
    return { processed: 0, results: [] };
  }

  const results = [];

  for (const idea of dueIdeas as Idea[]) {
    try {
      const reminderText = await generateSmartReminder(idea);
      const newCount = idea.reminder_count + 1;
      const nextReminder = calculateNextReminder(
        idea.reminder_frequency_hours, now
      );

      if (idea.thread_ts && idea.channel_id) {
        await postToThread(idea.channel_id, idea.thread_ts, reminderText);
      } else {
        await postToChannel(channelId, reminderText);
      }

      await supabase.from("ideas").update({
        reminder_count: newCount,
        last_reminder_at: now.toISOString(),
        next_reminder_at: nextReminder.toISOString(),
      }).eq("id", idea.id);

      await supabase.from("idea_updates").insert({
        idea_id: idea.id,
        update_type: "reminder_sent",
        content: reminderText,
        sent_to_slack: true,
      });

      results.push({
        idea_id: idea.id,
        title: idea.title,
        action: `reminder_${newCount}`,
      });
    } catch (err) {
      console.error(`[reminder] failed for idea ${idea.id}:`, err);
      results.push({
        idea_id: idea.id,
        title: idea.title,
        action: "error",
      });
    }
  }

  // Resume paused reminders whose pause period has expired
  await supabase
    .from("ideas")
    .update({ reminders_paused: false, pause_until: null })
    .eq("reminders_paused", true)
    .lte("pause_until", now.toISOString());

  return { processed: results.length, results };
}

export async function sendWeeklyDigest(): Promise<void> {
  const supabase = createPersonalSupabaseAdmin();
  const channelId = process.env.SLACK_CHANNEL_ID!;

  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [activeResult, completedResult, newResult] = await Promise.all([
    supabase.from("ideas").select("*").in("status", ["Active", "In Progress"]),
    supabase.from("ideas").select("*").eq("status", "Done")
      .gte("completed_at", oneWeekAgo.toISOString()),
    supabase.from("ideas").select("*")
      .gte("created_at", oneWeekAgo.toISOString()),
  ]);

  const active = activeResult.data ?? [];
  const completed = completedResult.data ?? [];
  const newIdeas = newResult.data ?? [];

  const highPriority = active.filter((i: Idea) => i.priority === "High");

  const digestText = `*Weekly Intelligence Briefing — ${new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}*

*Open Initiatives:* ${active.length} active${highPriority.length > 0 ? ` — ${highPriority.length} high priority` : ""}
*Completed This Week:* ${completed.length}
*New Ideas Captured:* ${newIdeas.length}

${highPriority.length > 0 ? `*Requires Attention:*\n${highPriority.slice(0, 3).map((i: Idea) => `• ${i.title} (${i.category})`).join("\n")}` : ""}

${completed.length > 0 ? `*Wins This Week:*\n${completed.slice(0, 3).map((i: Idea) => `✓ ${i.title}`).join("\n")}` : ""}

What would you like to focus on this week?`;

  await postToChannel(channelId, digestText);
}
