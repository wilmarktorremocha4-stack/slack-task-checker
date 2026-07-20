import { createPersonalSupabaseAdmin, Idea, IdeaStatus } from "./supabase-personal";
import { generateIdeaMetadata } from "./companion-ai";

const TIMEZONE = process.env.TEAM_TIMEZONE ?? "America/New_York";

function calculateNextReminder(
  frequencyHours: number,
  from: Date = new Date()
): Date {
  const next = new Date(from.getTime() + frequencyHours * 60 * 60 * 1000);

  const localDay = new Date(
    next.toLocaleString("en-US", { timeZone: TIMEZONE })
  ).getDay();

  if (localDay === 6) {
    next.setTime(next.getTime() + 2 * 24 * 60 * 60 * 1000);
  } else if (localDay === 0) {
    next.setTime(next.getTime() + 1 * 24 * 60 * 60 * 1000);
  }

  return next;
}

// ── CREATE IDEA ───────────────────────────────────────────────

export async function createIdea(options: {
  rawInput: string;
  channelId?: string;
  messageTs?: string;
  threadTs?: string;
  voiceTranscription?: string;
  audioFileUrl?: string;
  reminderFrequencyHours?: number;
  dueDate?: string;
}): Promise<Idea | null> {
  const supabase = createPersonalSupabaseAdmin();

  const metadata = await generateIdeaMetadata(options.rawInput);
  const frequencyHours = options.reminderFrequencyHours ?? 24;
  const nextReminder = calculateNextReminder(frequencyHours);

  const { data, error } = await supabase
    .from("ideas")
    .insert({
      title: metadata.title,
      raw_input: options.rawInput,
      summary: metadata.summary,
      action_steps: metadata.actionSteps,
      category: metadata.category,
      priority: metadata.priority,
      status: "Active",
      channel_id: options.channelId ?? null,
      message_ts: options.messageTs ?? null,
      thread_ts: options.threadTs ?? null,
      voice_transcription: options.voiceTranscription ?? null,
      audio_file_url: options.audioFileUrl ?? null,
      reminder_frequency_hours: frequencyHours,
      next_reminder_at: nextReminder.toISOString(),
      due_date: options.dueDate ?? null,
    })
    .select()
    .single();

  if (error) {
    console.error("[idea-manager] create failed:", error);
    return null;
  }

  await supabase.from("idea_updates").insert({
    idea_id: data.id,
    update_type: "created",
    content: `Idea captured: "${metadata.title}"`,
    sent_to_slack: true,
  });

  return data as Idea;
}

// ── UPDATE IDEA STATUS ────────────────────────────────────────

export async function updateIdeaStatus(
  ideaId: string,
  status: IdeaStatus,
  note?: string
): Promise<void> {
  const supabase = createPersonalSupabaseAdmin();

  const updateData: Record<string, unknown> = { status };

  if (status === "Done") {
    updateData.completed_at = new Date().toISOString();
    updateData.next_reminder_at = null;
  } else if (status === "Abandoned") {
    updateData.abandoned_at = new Date().toISOString();
    updateData.next_reminder_at = null;
  } else if (status === "Parked") {
    updateData.reminders_paused = true;
    updateData.next_reminder_at = null;
  }

  await supabase.from("ideas").update(updateData).eq("id", ideaId);

  await supabase.from("idea_updates").insert({
    idea_id: ideaId,
    update_type: "status_change",
    content: note ?? `Status changed to ${status}`,
    sent_to_slack: true,
  });
}

// ── SEARCH IDEAS ──────────────────────────────────────────────

export async function searchIdeas(query: string): Promise<Idea[]> {
  const supabase = createPersonalSupabaseAdmin();

  const { data } = await supabase
    .from("ideas")
    .select("*")
    .or(
      `title.ilike.%${query}%,summary.ilike.%${query}%,raw_input.ilike.%${query}%,category.ilike.%${query}%`
    )
    .order("created_at", { ascending: false })
    .limit(20);

  return (data ?? []) as Idea[];
}

// ── GET IDEAS WITH FILTERS ────────────────────────────────────

export async function getIdeas(filters?: {
  status?: IdeaStatus;
  category?: string;
  priority?: string;
  limit?: number;
}): Promise<Idea[]> {
  const supabase = createPersonalSupabaseAdmin();

  let query = supabase
    .from("ideas")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(filters?.limit ?? 50);

  if (filters?.status) query = query.eq("status", filters.status);
  if (filters?.category) query = query.eq("category", filters.category);
  if (filters?.priority) query = query.eq("priority", filters.priority);

  const { data } = await query;
  return (data ?? []) as Idea[];
}

// ── GET IDEA WITH FULL DETAIL ─────────────────────────────────

export async function getIdeaDetail(ideaId: string): Promise<{
  idea: Idea;
  updates: Array<Record<string, unknown>>;
  messages: Array<Record<string, unknown>>;
} | null> {
  const supabase = createPersonalSupabaseAdmin();

  const [ideaResult, updatesResult, messagesResult] = await Promise.all([
    supabase.from("ideas").select("*").eq("id", ideaId).single(),
    supabase
      .from("idea_updates")
      .select("*")
      .eq("idea_id", ideaId)
      .order("created_at", { ascending: true }),
    supabase
      .from("companion_messages")
      .select("*")
      .eq("idea_id", ideaId)
      .order("created_at", { ascending: true }),
  ]);

  if (!ideaResult.data) return null;

  return {
    idea: ideaResult.data as Idea,
    updates: updatesResult.data ?? [],
    messages: messagesResult.data ?? [],
  };
}

// ── PAUSE REMINDERS ───────────────────────────────────────────

export async function pauseReminders(
  ideaId: string,
  pauseDays: number = 7
): Promise<void> {
  const supabase = createPersonalSupabaseAdmin();
  const pauseUntil = new Date(
    Date.now() + pauseDays * 24 * 60 * 60 * 1000
  );

  await supabase.from("ideas").update({
    reminders_paused: true,
    pause_until: pauseUntil.toISOString(),
    next_reminder_at: null,
  }).eq("id", ideaId);

  await supabase.from("idea_updates").insert({
    idea_id: ideaId,
    update_type: "status_change",
    content: `Reminders paused for ${pauseDays} days`,
    sent_to_slack: true,
  });
}

// ── UPDATE REMINDER FREQUENCY ─────────────────────────────────

export async function updateReminderFrequency(
  ideaId: string,
  frequencyHours: number
): Promise<void> {
  const supabase = createPersonalSupabaseAdmin();
  const nextReminder = calculateNextReminder(frequencyHours);

  await supabase.from("ideas").update({
    reminder_frequency_hours: frequencyHours,
    next_reminder_at: nextReminder.toISOString(),
  }).eq("id", ideaId);
}
