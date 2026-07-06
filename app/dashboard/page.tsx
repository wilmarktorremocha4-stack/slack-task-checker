import { createSupabaseAdmin } from "@/lib/supabase";
import DashboardClient from "./DashboardClient";

export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const supabase = createSupabaseAdmin();

  const { data: tasks } = await supabase
    .from("tasks")
    .select("*, task_comments(*)")
    .order("created_at", { ascending: false })
    .limit(200);

  return <DashboardClient initialTasks={tasks ?? []} />;
}
