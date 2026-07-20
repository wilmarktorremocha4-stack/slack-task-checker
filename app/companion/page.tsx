import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { createPersonalSupabaseAdmin } from "@/lib/supabase-personal";
import { createTeamSupabaseReadOnly } from "@/lib/supabase-team";
import type { TeamTask } from "@/lib/supabase-team";
import CompanionClient from "./CompanionClient";

export const dynamic = "force-dynamic";

export default async function CompanionPage() {
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

  const personalSupabase = createPersonalSupabaseAdmin();
  const { data: ideas } = await personalSupabase
    .from("ideas")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(200);

  let teamTasks: TeamTask[] = [];
  try {
    const teamSupabase = createTeamSupabaseReadOnly();
    const { data: tasks } = await teamSupabase
      .from("tasks")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(200);
    teamTasks = tasks ?? [];
  } catch (err) {
    console.error("[companion] team fetch failed:", err);
  }

  return (
    <CompanionClient
      initialIdeas={ideas ?? []}
      initialTeamTasks={teamTasks}
      userEmail={user?.email ?? null}
    />
  );
}
