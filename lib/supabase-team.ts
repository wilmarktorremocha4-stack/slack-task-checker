import { createClient } from "@supabase/supabase-js";

// Team Supabase — READ ONLY from personal project
// Used only for the Team tab on the dashboard
// NEVER write to this from the personal project
export function createTeamSupabaseReadOnly() {
  return createClient(
    process.env.TEAM_SUPABASE_URL!,
    process.env.TEAM_SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

// Mirrors the team tasks table structure
export interface TeamTask {
  id: string;
  task_text: string;
  assigned_to_name: string;
  assignee_names: string[];
  assigned_by_name: string;
  status: string;
  followup_count: number;
  max_followups: number;
  next_followup_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  workspace_type: string;
}
