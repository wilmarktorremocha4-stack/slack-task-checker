"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowser } from "@/lib/supabase-browser";

export default function ResetPasswordPage() {
  const router = useRouter();
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
      router.push("/dashboard");
      router.refresh();
    }
  }

  return (
    <main className="min-h-screen relative flex items-center justify-center p-4 bg-[#040b18] overflow-hidden">
      <div className="pointer-events-none absolute -top-48 -left-48 w-[40rem] h-[40rem] rounded-full bg-blue-600/15 blur-[120px]" />
      <div className="pointer-events-none absolute -bottom-48 -right-32 w-[36rem] h-[36rem] rounded-full bg-indigo-700/15 blur-[120px]" />

      <div className="relative w-full max-w-md">
        <div className="flex flex-col items-center mb-8">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center text-2xl shadow-lg shadow-indigo-500/30 mb-4">
            🔑
          </div>
          <h1 className="text-2xl font-bold text-white/90 tracking-tight">Set a new password</h1>
          <p className="text-white/30 text-sm mt-1">Choose a strong password you haven&apos;t used before</p>
        </div>

        <div className="bg-white/[0.05] backdrop-blur-xl border border-white/10 rounded-3xl shadow-2xl shadow-black/60 p-8">
          {error && (
            <div className="mb-5 px-4 py-3 rounded-xl text-sm bg-rose-500/10 border border-rose-500/30 text-rose-300">
              {error}
            </div>
          )}

          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-white/50 mb-1.5">New password</label>
              <input
                type="password"
                required
                autoComplete="new-password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full bg-white/[0.07] border border-white/10 rounded-xl px-4 py-3 text-sm text-white/80 placeholder-white/25 hover:border-white/20 focus:outline-none focus:ring-2 focus:ring-indigo-400/30 focus:border-indigo-400/40 transition-all"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-white/50 mb-1.5">Confirm new password</label>
              <input
                type="password"
                required
                autoComplete="new-password"
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full bg-white/[0.07] border border-white/10 rounded-xl px-4 py-3 text-sm text-white/80 placeholder-white/25 hover:border-white/20 focus:outline-none focus:ring-2 focus:ring-indigo-400/30 focus:border-indigo-400/40 transition-all"
              />
            </div>

            <button
              type="submit"
              disabled={busy}
              className="w-full bg-gradient-to-r from-blue-500 via-indigo-500 to-violet-600 hover:from-blue-600 hover:via-indigo-600 hover:to-violet-700 hover:shadow-xl hover:shadow-indigo-500/30 hover:-translate-y-0.5 disabled:opacity-60 disabled:hover:translate-y-0 text-white font-semibold text-sm py-3.5 rounded-xl shadow-lg shadow-indigo-500/20 transition-all active:scale-[0.98]"
            >
              {busy ? "Saving..." : "Save New Password"}
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}
