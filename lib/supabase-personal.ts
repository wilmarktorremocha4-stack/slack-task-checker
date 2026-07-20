import { createClient } from "@supabase/supabase-js";

// Personal Supabase — all reads and writes for the companion
export function createPersonalSupabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

export function createPersonalSupabaseBrowser() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

// ── TYPES ──────────────────────────────────────────────────

export type IdeaStatus =
  | "Active" | "In Progress" | "Done" | "Parked" | "Abandoned";

export type IdeaCategory =
  | "Business" | "Content" | "Product" | "Operations"
  | "Personal" | "Research" | "Finance" | "Marketing"
  | "Technology" | "Other" | "General";

export type IdeaPriority = "High" | "Medium" | "Low";

export interface Idea {
  id: string;
  title: string;
  raw_input: string;
  summary: string | null;
  action_steps: string[] | null;
  category: IdeaCategory;
  priority: IdeaPriority;
  status: IdeaStatus;
  channel_id: string | null;
  message_ts: string | null;
  thread_ts: string | null;
  voice_transcription: string | null;
  audio_file_url: string | null;
  reminder_frequency_hours: number;
  next_reminder_at: string | null;
  last_reminder_at: string | null;
  reminder_count: number;
  reminders_paused: boolean;
  pause_until: string | null;
  due_date: string | null;
  research_results: string | null;
  research_query: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  abandoned_at: string | null;
}

export interface IdeaUpdate {
  id: string;
  idea_id: string;
  update_type: string;
  content: string;
  sent_to_slack: boolean;
  created_at: string;
}

export interface CompanionMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  channel_id: string | null;
  thread_ts: string | null;
  idea_id: string | null;
  tokens_used: number;
  created_at: string;
}
