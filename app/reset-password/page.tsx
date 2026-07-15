"use client";

import { useState } from "react";
import { createSupabaseBrowser } from "@/lib/supabase-browser";

export default function ResetPasswordPage() {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setBusy(true);
    const supabase = createSupabaseBrowser();
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setBusy(false);

    if (updateError) {
      setError(updateError.message);
    } else {
      window.location.href = "/dashboard";
    }
  }

  return (
    <main className="min-h-screen relative flex items-center justify-center p-4 bg-gradient-to-br from-indigo-200 via-sky-100 to-blue-200 overflow-hidden">
      <div className="pointer-events-none absolute -top-32 -left-32 w-96 h-96 rounded-full bg-blue-400/30 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-40 -right-24 w-[28rem] h-[28rem] rounded-full bg-indigo-400/30 blur-3xl" />

      <div className="relative w-full max-w-md">
        <div className="flex flex-col items-center mb-8">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center text-2xl shadow-lg shadow-indigo-500/30 mb-4">
            🔑
          </div>
          <h1 className="text-2xl font-bold text-slate-800 tracking-tight">Set a new password</h1>
          <p className="text-slate-600 text-sm mt-1">Choose a strong password you haven&apos;t used before</p>
        </div>

        <div className="bg-gradient-to-b from-blue-50/95 to-indigo-100/90 backdrop-blur-xl border border-blue-200/80 rounded-3xl shadow-2xl shadow-indigo-400/30 p-8">
          {error && (
            <div className="mb-5 px-4 py-3 rounded-xl text-sm bg-rose-50 border border-rose-200 text-rose-700">
              {error}
            </div>
          )}

          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-600 mb-1.5">New password</label>
              <input
                type="password"
                required
                autoComplete="new-password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full bg-white/90 border border-blue-200 rounded-xl px-4 py-3 text-sm text-slate-800 placeholder-slate-400 hover:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-400/60 focus:border-blue-400 transition-all"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-600 mb-1.5">Confirm new password</label>
              <input
                type="password"
                required
                autoComplete="new-password"
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full bg-white/90 border border-blue-200 rounded-xl px-4 py-3 text-sm text-slate-800 placeholder-slate-400 hover:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-400/60 focus:border-blue-400 transition-all"
              />
            </div>

            <button
              type="submit"
              disabled={busy}
              className="w-full bg-gradient-to-r from-blue-600 via-indigo-500 to-violet-600 hover:from-blue-700 hover:via-indigo-600 hover:to-violet-700 hover:shadow-xl hover:shadow-indigo-500/40 hover:-translate-y-0.5 disabled:opacity-60 disabled:hover:translate-y-0 text-white font-semibold text-sm py-3.5 rounded-xl shadow-lg shadow-indigo-500/30 transition-all active:scale-[0.98]"
            >
              {busy ? "Saving..." : "Save New Password"}
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}
