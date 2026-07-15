import { NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase";
import { Resend } from "resend";

const FROM_EMAIL = process.env.RESEND_FROM_EMAIL ?? "Task Tracker <noreply@operationamz.net>";

export async function POST(req: Request) {
  try {
    const { email } = await req.json();
    if (!email) return NextResponse.json({ error: "Email required" }, { status: 400 });

    const supabase = createSupabaseAdmin();
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://slack-task-checker.vercel.app";

    const { data, error } = await supabase.auth.admin.generateLink({
      type: "recovery",
      email,
      options: { redirectTo: `${appUrl}/auth/callback?next=/reset-password` },
    });

    // Always return success so we don't reveal which emails exist
    if (error || !data?.properties?.action_link) {
      return NextResponse.json({ ok: true });
    }

    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: FROM_EMAIL,
      to: email,
      subject: "Reset your Task Tracker password",
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px">
          <h2 style="margin:0 0 16px;font-size:20px;color:#1e293b">Reset your password</h2>
          <p style="color:#475569;margin:0 0 24px;line-height:1.5">
            Click the button below to reset your Task Tracker password. This link expires in 1 hour.
          </p>
          <a href="${data.properties.action_link}"
             style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;font-size:14px">
            Reset Password
          </a>
          <p style="color:#94a3b8;margin:24px 0 0;font-size:12px">
            If you didn't request this, you can safely ignore this email.
          </p>
        </div>
      `,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[auth] forgot-password error:", err);
    return NextResponse.json({ ok: true }); // still return success
  }
}
