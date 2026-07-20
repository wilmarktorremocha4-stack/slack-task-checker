import { NextResponse } from "next/server";
import { createPersonalSupabaseAdmin } from "@/lib/supabase-personal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const category = searchParams.get("category");
  const search = searchParams.get("search");

  const supabase = createPersonalSupabaseAdmin();

  let query = supabase
    .from("ideas")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(100);

  if (status && status !== "all") query = query.eq("status", status);
  if (category && category !== "all") query = query.eq("category", category);
  if (search) {
    query = query.or(
      `title.ilike.%${search}%,summary.ilike.%${search}%,raw_input.ilike.%${search}%`
    );
  }

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ideas: data ?? [] });
}
