import { NextResponse } from "next/server";
import { getSlackClient } from "@/lib/slack";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const slack = getSlackClient();
    const result = await slack.users.list({ limit: 200 });

    const members = (result.members ?? [])
      .filter(u => !u.is_bot && !u.deleted && u.id !== "USLACKBOT")
      .map(u => ({
        id: u.id!,
        name:
          u.profile?.display_name ||
          u.profile?.real_name ||
          u.name ||
          u.id!,
      }))
      .filter(u => u.name);

    return NextResponse.json({ members });
  } catch (err) {
    console.error("[slack/users] error:", err);
    return NextResponse.json({ error: "Failed to fetch users" }, { status: 500 });
  }
}
