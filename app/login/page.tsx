"use client";

import { useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { createSupabaseBrowser } from "@/lib/supabase-browser";

type Mode = "signin" | "signup" | "otp" | "forgot";

const GRADIENT_BG = "linear-gradient(180deg, #060d24 0%, #0d2f7a 28%, #1565c0 56%, #1e88e5 76%, #42a5f5 100%)";

function Spinner() {
  return (
    <svg className="w-4 h-4 anim-spin-slow" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

const INPUT_CLS =
  "w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm text-slate-800 placeholder-slate-400 hover:border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 transition-all";

function LoginForm() {
  const searchParams = useSearchParams();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(
    searchParams.get("error") === "not_allowed"
      ? { text: "That account is not authorized to access this dashboard.", ok: false }
      : searchParams.get("error") === "auth_failed"
      ? { text: "That link is invalid or expired. Please try again.", ok: false }
      : null
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    setBusy(true);
    const supabase = createSupabaseBrowser();

    try {
      if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) { setMessage({ text: error.message, ok: false }); }
        else { window.location.href = "/dashboard"; return; }

      } else if (mode === "signup") {
        if (password.length < 8) { setMessage({ text: "Password must be at least 8 characters.", ok: false }); setBusy(false); return; }
        if (password !== confirmPassword) { setMessage({ text: "Passwords do not match.", ok: false }); setBusy(false); return; }
        const res = await fetch("/api/auth/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
        const json = await res.json();
        if (!res.ok) { setMessage({ text: json.error ?? "Something went wrong.", ok: false }); }
        else { setMessage({ text: `A 6-digit verification code was sent to ${email}.`, ok: true }); setMode("otp"); }

      } else if (mode === "otp") {
        const res = await fetch("/api/auth/verify-otp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, otp_code: otpCode }) });
        const json = await res.json();
        if (!res.ok) { setMessage({ text: json.error ?? "Invalid code.", ok: false }); }
        else {
          setMessage({ text: "Email verified! You can now sign in.", ok: true });
          setOtpCode("");
          setMode("signin");
        }

      } else {
        const res = await fetch("/api/auth/forgot-password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
        if (!res.ok) { setMessage({ text: "Something went wrong. Please try again.", ok: false }); }
        else { setMessage({ text: "If an account exists for this email, a password reset link has been sent. Check your inbox.", ok: true }); }
      }
    } catch { setMessage({ text: "Something went wrong. Please try again.", ok: false }); }
    finally { setBusy(false); }
  }

  async function resendOtp() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/auth/send-otp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
      if (res.ok) { setMessage({ text: "A new code was sent to your email.", ok: true }); }
      else { setMessage({ text: "Failed to resend code. Please try again.", ok: false }); }
    } catch { setMessage({ text: "Something went wrong.", ok: false }); }
    finally { setBusy(false); }
  }

  const headings: Record<Mode, string> = {
    signin: "Welcome back",
    signup: "Create account",
    otp: "Check your email",
    forgot: "Reset password",
  };

  const ctas: Record<Mode, string> = {
    signin: "Sign In",
    signup: "Create Account",
    otp: "Verify Code",
    forgot: "Send Reset Link",
  };

  return (
    <main className="min-h-screen relative flex items-center justify-center p-4 overflow-hidden">
      <div className="fixed inset-0 -z-10" style={{ background: GRADIENT_BG }} />

      <div className="relative w-full max-w-md anim-pop">
        {/* Brand */}
        <div className="flex flex-col items-center mb-8">
          <h1 className="text-5xl font-black tracking-tight text-white mb-1" style={{ textShadow: "0 2px 20px rgba(0,0,0,0.35)" }}>
            Task{" "}
            <span style={{ background: "linear-gradient(90deg, #38bdf8 0%, #7dd3fc 40%, #e0f2fe 100%)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
              Tracker
            </span>
          </h1>
          <p className="text-blue-100/80 text-sm font-medium drop-shadow">Internal Access Only</p>
        </div>

        {/* Card */}
        <div className="p-[2px] rounded-3xl shadow-2xl shadow-black/40" style={{ background: "linear-gradient(135deg, #38bdf8 0%, #818cf8 40%, #a78bfa 70%, #38bdf8 100%)" }}>
        <div className="bg-white rounded-[22px] p-8">
          <h2 className="text-xl font-bold mb-6 text-center text-slate-900 tracking-tight">
            {headings[mode]}
          </h2>

          {mode === "otp" && (
            <p className="text-sm text-slate-500 text-center mb-5">
              Enter the 6-digit code sent to <span className="font-semibold text-slate-700">{email}</span>
            </p>
          )}

          {message && (
            <div className={`mb-5 px-4 py-3 rounded-xl text-sm border ${
              message.ok
                ? "bg-emerald-50 border-emerald-300 text-emerald-800"
                : "bg-rose-50 border-rose-300 text-rose-800"
            }`}>
              {message.text}
            </div>
          )}

          <form onSubmit={submit} className="space-y-4">
            {mode !== "otp" && (
              <div>
                <label className="block text-sm font-medium text-slate-600 mb-1.5">Email</label>
                <input
                  type="email" required autoComplete="email" value={email}
                  onChange={e => setEmail(e.target.value)} placeholder="you@yourcompany.com"
                  className={INPUT_CLS}
                />
              </div>
            )}

            {(mode === "signin" || mode === "signup") && (
              <div>
                <label className="block text-sm font-medium text-slate-600 mb-1.5">Password</label>
                <input
                  type="password" required autoComplete={mode === "signup" ? "new-password" : "current-password"}
                  value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••"
                  className={INPUT_CLS}
                />
              </div>
            )}

            {mode === "signup" && (
              <div>
                <label className="block text-sm font-medium text-slate-600 mb-1.5">Confirm password</label>
                <input
                  type="password" required autoComplete="new-password"
                  value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} placeholder="••••••••"
                  className={INPUT_CLS}
                />
              </div>
            )}

            {mode === "otp" && (
              <div>
                <label className="block text-sm font-medium text-slate-600 mb-1.5">Verification code</label>
                <input
                  type="text" required inputMode="numeric" maxLength={6} pattern="\d{6}"
                  value={otpCode} onChange={e => setOtpCode(e.target.value.replace(/\D/g, ""))}
                  placeholder="000000"
                  className={`${INPUT_CLS} text-center text-2xl font-bold tracking-[0.4em]`}
                  autoFocus
                />
              </div>
            )}

            {mode === "signin" && (
              <div className="text-right">
                <button type="button" onClick={() => { setMode("forgot"); setMessage(null); }} className="text-xs text-blue-600 hover:text-blue-700 hover:underline underline-offset-2 font-medium transition-colors">
                  Forgot password?
                </button>
              </div>
            )}

            <button
              type="submit" disabled={busy}
              className="w-full inline-flex items-center justify-center gap-2.5 hover:-translate-y-0.5 disabled:opacity-60 disabled:hover:translate-y-0 text-white font-semibold text-sm py-3.5 rounded-xl shadow-lg shadow-blue-500/40 transition-all active:scale-[0.98]"
              style={{ background: "linear-gradient(135deg, #2563eb 0%, #7c3aed 60%, #06b6d4 100%)" }}
            >
              {busy && <Spinner />}
              {busy ? "Please wait..." : ctas[mode]}
            </button>
          </form>

          <div className="mt-6 pt-5 border-t border-slate-200 text-center text-sm text-slate-500">
            {mode === "signin" && (
              <>No account yet?{" "}
                <button onClick={() => { setMode("signup"); setMessage(null); }} className="text-blue-600 hover:text-blue-700 hover:underline underline-offset-2 font-semibold transition-colors">Sign up</button>
              </>
            )}
            {mode === "signup" && (
              <>Already have an account?{" "}
                <button onClick={() => { setMode("signin"); setMessage(null); }} className="text-blue-600 hover:text-blue-700 hover:underline underline-offset-2 font-semibold transition-colors">Sign in</button>
              </>
            )}
            {mode === "otp" && (
              <>Didn&apos;t receive it?{" "}
                <button type="button" disabled={busy} onClick={resendOtp} className="text-blue-600 hover:text-blue-700 hover:underline underline-offset-2 font-semibold transition-colors disabled:opacity-50">Resend code</button>
                {" · "}
                <button type="button" onClick={() => { setMode("signup"); setMessage(null); setOtpCode(""); }} className="text-blue-600 hover:text-blue-700 hover:underline underline-offset-2 font-semibold transition-colors">Back</button>
              </>
            )}
            {mode === "forgot" && (
              <button onClick={() => { setMode("signin"); setMessage(null); }} className="text-blue-600 hover:text-blue-700 hover:underline underline-offset-2 font-semibold transition-colors">
                ← Back to sign in
              </button>
            )}
          </div>
        </div>
        </div>

        <p className="text-center text-xs text-white font-medium mt-6 drop-shadow" style={{ textShadow: "0 1px 8px rgba(0,0,0,0.4)" }}>
          Access is limited to authorized team members.
        </p>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
