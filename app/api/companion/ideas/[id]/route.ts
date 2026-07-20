import { NextResponse } from "next/server";
import { getIdeaDetail, updateIdeaStatus } from "@/lib/idea-manager";
import { IdeaStatus } from "@/lib/supabase-personal";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const detail = await getIdeaDetail(id);
  if (!detail) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(detail);
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { status, note } = await request.json();

  if (status) {
    await updateIdeaStatus(id, status as IdeaStatus, note);
  }

  return NextResponse.json({ ok: true });
}
