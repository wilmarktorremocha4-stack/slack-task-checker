import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { createSupabaseAdmin } from "@/lib/supabase";
import DashboardClient from "./DashboardClient";

export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const cookieStore = await cookies();
  const supabaseAuth = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll() {
          // Read-only in a Server Component; proxy.ts handles session refresh
        },
      },
    }
  );
  const {
    data: { user },
  } = await supabaseAuth.auth.getUser();

  const supabase = createSupabaseAdmin();
  const { data: tasks } = await supabase
    .from("tasks")
    .select("*, task_comments(*)")
    .order("created_at", { ascending: false })
    .limit(200);

  return <DashboardClient initialTasks={tasks ?? []} userEmail={user?.email ?? null} />;
}
