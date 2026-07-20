import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { createPersonalSupabaseAdmin } from "@/lib/supabase-personal";
import { createTeamSupabaseReadOnly } from "@/lib/supabase-team";
import type { TeamTask } from "@/lib/supabase-team";
import DashboardClient from "./DashboardClient";

export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const cookieStore = await cookies();

  const supabaseAuth = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll(); },
        setAll() {},
      },
    }
  );

  const { data: { user } } = await supabaseAuth.auth.getUser();

  // Personal ideas from personal Supabase
  const personalSupabase = createPersonalSupabaseAdmin();
  const { data: ideas } = await personalSupabase
    .from("ideas")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(200);

  // Team tasks from team Supabase (read-only)
  let teamTasks: TeamTask[] = [];
  try {
    const teamSupabase = createTeamSupabaseReadOnly();
    const { data: tasks } = await teamSupabase
      .from("tasks")
      .select("*, task_comments(*)")
      .order("created_at", { ascending: false })
      .limit(200);
    teamTasks = tasks ?? [];
  } catch (err) {
    console.error("[dashboard] team fetch failed:", err);
  }

  return (
    <DashboardClient
      initialIdeas={ideas ?? []}
      initialTeamTasks={teamTasks}
      userEmail={user?.email ?? null}
    />
  );
}
