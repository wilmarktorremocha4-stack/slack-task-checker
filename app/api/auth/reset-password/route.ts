import { NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase";

export async function POST(req: Request) {
  try {
    const { email, otp_code, new_password } = await req.json();
    if (!email || !otp_code || !new_password) {
      return NextResponse.json({ error: "Email, code, and new password are required." }, { status: 400 });
    }
    if (new_password.length < 8) {
      return NextResponse.json({ error: "Password must be at least 8 characters." }, { status: 400 });
    }

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
      return NextResponse.json({ error: "Invalid code. Please check and try again." }, { status: 400 });
    }

    if (new Date(record.expires_at) < new Date()) {
      return NextResponse.json({ error: "This code has expired. Please request a new one." }, { status: 400 });
    }

    // Mark OTP as used
    await supabase.from("email_otps").update({ used: true }).eq("id", record.id);

    // Find the user and update their password
    const { data: users } = await supabase.auth.admin.listUsers();
    const user = users?.users?.find((u) => u.email === email);
    if (!user) {
      return NextResponse.json({ error: "Account not found." }, { status: 400 });
    }

    const { error: updateError } = await supabase.auth.admin.updateUserById(user.id, {
      password: new_password,
    });

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 400 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[auth] reset-password error:", err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
