import { NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase";

export async function POST(req: Request) {
  try {
    const { email, otp_code } = await req.json();
    if (!email || !otp_code) return NextResponse.json({ error: "Email and code required" }, { status: 400 });

    const supabase = createSupabaseAdmin();

    const { data: record } = await supabase
      .from("email_otps")
      .select("id, expires_at, used")
      .eq("email", email)
      .eq("otp_code", otp_code)
      .eq("used", false)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!record) {
      return NextResponse.json({ error: "Invalid verification code." }, { status: 400 });
    }

    if (new Date(record.expires_at) < new Date()) {
      return NextResponse.json({ error: "This code has expired. Please request a new one." }, { status: 400 });
    }

    // Mark OTP as used
    await supabase.from("email_otps").update({ used: true }).eq("id", record.id);

    // Confirm the user's email in Supabase Auth
    const { data: users } = await supabase.auth.admin.listUsers();
    const user = users?.users?.find((u) => u.email === email);
    if (user) {
      await supabase.auth.admin.updateUserById(user.id, { email_confirm: true });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[auth] verify-otp error:", err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
