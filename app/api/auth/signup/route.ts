import { NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase";
import { Resend } from "resend";

const FROM_EMAIL = process.env.RESEND_FROM_EMAIL ?? "Task Tracker <noreply@operationamz.net>";

export async function POST(req: Request) {
  try {
    const { email, password } = await req.json();
    if (!email || !password) return NextResponse.json({ error: "Email and password required" }, { status: 400 });
    if (password.length < 8) return NextResponse.json({ error: "Password must be at least 8 characters." }, { status: 400 });

    const supabase = createSupabaseAdmin();
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://slack-task-checker.vercel.app";

    // Create the user (unconfirmed)
    const { data: userData, error: createError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: false,
    });

    if (createError) {
      // Surface duplicate email error clearly
      if (createError.message.toLowerCase().includes("already")) {
        return NextResponse.json({ error: "An account with this email already exists." }, { status: 400 });
      }
      return NextResponse.json({ error: createError.message }, { status: 400 });
    }

    // Generate email confirmation link
    const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
      type: "signup",
      email,
      password,
      options: { redirectTo: `${appUrl}/auth/callback` },
    });

    if (linkError || !linkData?.properties?.action_link) {
      console.error("[auth] generateLink error:", linkError);
      return NextResponse.json({ ok: true }); // account created, email just won't send
    }

    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: FROM_EMAIL,
      to: email,
      subject: "Verify your Task Tracker account",
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px">
          <h2 style="margin:0 0 16px;font-size:20px;color:#1e293b">Verify your email</h2>
          <p style="color:#475569;margin:0 0 24px;line-height:1.5">
            Click the button below to verify your email and activate your Task Tracker account.
          </p>
          <a href="${linkData.properties.action_link}"
             style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;font-size:14px">
            Verify Email
          </a>
          <p style="color:#94a3b8;margin:24px 0 0;font-size:12px">
            If you didn't sign up for Task Tracker, you can safely ignore this email.
          </p>
        </div>
      `,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[auth] signup error:", err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
