import { NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase";
import { Resend } from "resend";

const FROM_EMAIL = process.env.RESEND_FROM_EMAIL ?? "Task Tracker <noreply@operationamz.net>";

function generateOtp(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export async function POST(req: Request) {
  try {
    const { email } = await req.json();
    if (!email) return NextResponse.json({ error: "Email required" }, { status: 400 });

    const supabase = createSupabaseAdmin();
    const otp = generateOtp();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Invalidate any previous unused OTPs for this email
    await supabase.from("email_otps").update({ used: true }).eq("email", email).eq("used", false);

    // Store new OTP
    await supabase.from("email_otps").insert({ email, otp_code: otp, expires_at: expiresAt.toISOString() });

    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: FROM_EMAIL,
      to: email,
      subject: "Your Task Tracker verification code",
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px">
          <h2 style="margin:0 0 16px;font-size:20px;color:#1e293b">Verify your email</h2>
          <p style="color:#475569;margin:0 0 24px;line-height:1.5">
            Enter this code to verify your Task Tracker account. It expires in 10 minutes.
          </p>
          <div style="background:#f1f5f9;border-radius:12px;padding:24px;text-align:center;margin-bottom:24px">
            <span style="font-size:36px;font-weight:800;letter-spacing:12px;color:#1e293b">${otp}</span>
          </div>
          <p style="color:#94a3b8;font-size:12px;margin:0">
            If you didn't sign up for Task Tracker, you can safely ignore this email.
          </p>
        </div>
      `,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[auth] send-otp error:", err);
    return NextResponse.json({ error: "Failed to send verification code." }, { status: 500 });
  }
}
