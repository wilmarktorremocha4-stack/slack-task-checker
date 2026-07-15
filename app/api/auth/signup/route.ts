import { NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase";

export async function POST(req: Request) {
  try {
    const { email, password } = await req.json();
    if (!email || !password) return NextResponse.json({ error: "Email and password required" }, { status: 400 });
    if (password.length < 8) return NextResponse.json({ error: "Password must be at least 8 characters." }, { status: 400 });

    const supabase = createSupabaseAdmin();

    // Create the user (unconfirmed) — email confirmation handled via OTP
    const { error: createError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: false,
    });

    if (createError) {
      if (createError.message.toLowerCase().includes("already")) {
        return NextResponse.json({ error: "An account with this email already exists." }, { status: 400 });
      }
      return NextResponse.json({ error: createError.message }, { status: 400 });
    }

    // Trigger OTP send
    const sendRes = await fetch(
      `${process.env.NEXT_PUBLIC_APP_URL ?? "https://slack-task-checker.vercel.app"}/api/auth/send-otp`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) }
    );

    if (!sendRes.ok) {
      return NextResponse.json({ error: "Account created but failed to send verification code. Try signing in and use Forgot Password." }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[auth] signup error:", err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
