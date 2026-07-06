import { createClient } from "@supabase/supabase-js";

export function createSupabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

export interface Task {
  id: string;
  task_text: string;
  raw_message: string;
  assigned_to_id: string;
  assigned_to_name: string;
  assigned_by_id: string;
  assigned_by_name: string;
  channel_id: string;
  message_ts: string;
  thread_ts: string;
  status: "active" | "completed" | "escalated" | "cancelled";
  followup_count: number;
  max_followups: number;
  next_followup_at: string | null;
  last_followup_at: string | null;
  completed_at: string | null;
  escalated_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface FollowupLog {
  id: string;
  task_id: string;
  followup_number: number;
  message_sent: string;
  sent_at: string;
  was_escalation: boolean;
}
