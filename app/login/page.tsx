"use client";

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createSupabaseBrowser } from "@/lib/supabase-browser";
import { isAllowedEmail } from "@/lib/auth";

type Mode = "signin" | "signup" | "forgot";

function Spinner() {
  return (
    <svg className="w-4 h-4 anim-spin-slow" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
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

    if (!isAllowedEmail(email)) {
      setMessage({ text: "This email is not authorized to access the Task Tracker.", ok: false });
      return;
    }

    setBusy(true);
    const supabase = createSupabaseBrowser();

    try {
      if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) { setMessage({ text: error.message, ok: false }); }
        else { router.push("/dashboard"); router.refresh(); return; }
      } else if (mode === "signup") {
        if (password.length < 8) { setMessage({ text: "Password must be at least 8 characters.", ok: false }); }
        else if (password !== confirmPassword) { setMessage({ text: "Passwords do not match.", ok: false }); }
        else {
          const { error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: `${window.location.origin}/auth/callback` } });
          if (error) { setMessage({ text: error.message, ok: false }); }
          else { setMessage({ text: "Account created! Check your inbox for a verification link before signing in.", ok: true }); setMode("signin"); }
        }
      } else {
        const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/auth/callback?next=/reset-password` });
        if (error) { setMessage({ text: error.message, ok: false }); }
        else { setMessage({ text: "If an account exists for this email, a password reset link has been sent. Check your inbox.", ok: true }); }
      }
    } catch { setMessage({ text: "Something went wrong. Please try again.", ok: false }); }
    finally { setBusy(false); }
  }

  const titles: Record<Mode, { heading: string; cta: string }> = {
    signin: { heading: "Welcome back", cta: "Sign In" },
    signup: { heading: "Create account", cta: "Create Account" },
    forgot: { heading: "Reset password", cta: "Send Reset Link" },
  };

  return (
    <main className="min-h-screen relative flex items-center justify-center p-4 bg-[#050e24] overflow-hidden">
      {/* Dot grid */}
      <div className="pointer-events-none absolute inset-0 dot-grid" />

      {/* Glow orbs */}
      <div className="pointer-events-none absolute -top-40 -left-40 w-[600px] h-[500px] rounded-full bg-blue-600/15 blur-[140px] anim-glow" />
      <div className="pointer-events-none absolute -bottom-60 -right-40 w-[500px] h-[500px] rounded-full bg-blue-800/15 blur-[120px] anim-glow" style={{ animationDelay: "2s" }} />
      <div className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[300px] rounded-full bg-indigo-900/10 blur-[100px]" />

      <div className="relative w-full max-w-md anim-pop">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center text-3xl shadow-2xl shadow-blue-500/40 mb-4 ring-1 ring-blue-400/20">
            📋
          </div>
          <h1 className="text-2xl font-bold tracking-tight bg-gradient-to-r from-white to-blue-200 bg-clip-text text-transparent">Task Tracker</h1>
          <p className="text-slate-500 text-sm mt-1">Internal Access Only</p>
        </div>

        {/* Card */}
        <div className="bg-slate-900/80 backdrop-blur-xl border border-slate-700/60 rounded-3xl shadow-2xl shadow-black/60 p-8">
          <h2 className="text-2xl font-bold mb-6 text-center bg-gradient-to-r from-blue-400 via-blue-300 to-white bg-clip-text text-transparent tracking-tight">
            {titles[mode].heading}
          </h2>

          {message && (
            <div className={`mb-5 px-4 py-3 rounded-xl text-sm border ${
              message.ok
                ? "bg-emerald-950/60 border-emerald-500/30 text-emerald-300"
                : "bg-rose-950/60 border-rose-500/30 text-rose-300"
            }`}>
              {message.text}
            </div>
          )}

          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-400 mb-1.5">Email</label>
              <input
                type="email" required autoComplete="email" value={email}
                onChange={e => setEmail(e.target.value)} placeholder="you@operationamz.com"
                className="w-full bg-slate-800/60 border border-slate-700/60 rounded-xl px-4 py-3 text-sm text-slate-200 placeholder-slate-500 hover:border-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500/50 transition-all"
              />
            </div>

            {mode !== "forgot" && (
              <div>
                <label className="block text-sm font-medium text-slate-400 mb-1.5">Password</label>
                <input
                  type="password" required autoComplete={mode === "signup" ? "new-password" : "current-password"}
                  value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••"
                  className="w-full bg-slate-800/60 border border-slate-700/60 rounded-xl px-4 py-3 text-sm text-slate-200 placeholder-slate-500 hover:border-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500/50 transition-all"
                />
              </div>
            )}

            {mode === "signup" && (
              <div>
                <label className="block text-sm font-medium text-slate-400 mb-1.5">Confirm password</label>
                <input
                  type="password" required autoComplete="new-password"
                  value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} placeholder="••••••••"
                  className="w-full bg-slate-800/60 border border-slate-700/60 rounded-xl px-4 py-3 text-sm text-slate-200 placeholder-slate-500 hover:border-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500/50 transition-all"
                />
              </div>
            )}

            {mode === "signin" && (
              <div className="text-right">
                <button type="button" onClick={() => { setMode("forgot"); setMessage(null); }} className="text-xs text-blue-400 hover:text-blue-300 hover:underline underline-offset-2 font-medium transition-colors">
                  Forgot password?
                </button>
              </div>
            )}

            <button
              type="submit" disabled={busy}
              className="w-full inline-flex items-center justify-center gap-2.5 bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 hover:shadow-xl hover:shadow-blue-500/30 hover:-translate-y-0.5 disabled:opacity-60 disabled:hover:translate-y-0 text-white font-semibold text-sm py-3.5 rounded-xl shadow-lg shadow-blue-500/25 transition-all active:scale-[0.98]"
            >
              {busy && <Spinner />}
              {busy ? "Please wait..." : titles[mode].cta}
            </button>
          </form>

          <div className="mt-6 pt-5 border-t border-slate-700/40 text-center text-sm text-slate-500">
            {mode === "signin" && (
              <>
                No account yet?{" "}
                <button onClick={() => { setMode("signup"); setMessage(null); }} className="text-blue-400 hover:text-blue-300 hover:underline underline-offset-2 font-semibold transition-colors">
                  Sign up
                </button>
              </>
            )}
            {mode === "signup" && (
              <>
                Already have an account?{" "}
                <button onClick={() => { setMode("signin"); setMessage(null); }} className="text-blue-400 hover:text-blue-300 hover:underline underline-offset-2 font-semibold transition-colors">
                  Sign in
                </button>
              </>
            )}
            {mode === "forgot" && (
              <button onClick={() => { setMode("signin"); setMessage(null); }} className="text-blue-400 hover:text-blue-300 hover:underline underline-offset-2 font-semibold transition-colors">
                ← Back to sign in
              </button>
            )}
          </div>
        </div>

        <p className="text-center text-xs text-slate-600 mt-6">
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
