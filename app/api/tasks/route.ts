import { NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase";

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status") ?? "active";
  const limit = parseInt(searchParams.get("limit") ?? "50");

  const supabase = createSupabaseAdmin();

  const query = supabase
    .from("tasks")
    .select(`
      *,
      followup_logs(*)
    `)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (status !== "all") {
    query.eq("status", status);
  }

  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    tasks: data,
    count: data?.length ?? 0,
    filter: status,
  });
}
