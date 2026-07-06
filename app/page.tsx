import Link from "next/link";

export default function Home() {
  return (
    <main className="min-h-screen relative bg-gradient-to-br from-slate-50 via-indigo-50/60 to-violet-100/50 text-slate-800 p-8 overflow-hidden">
      <div className="pointer-events-none absolute -top-32 -left-32 w-96 h-96 rounded-full bg-indigo-300/25 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-40 -right-24 w-[28rem] h-[28rem] rounded-full bg-violet-300/25 blur-3xl" />

      <div className="relative max-w-2xl mx-auto">
        <div className="flex items-center justify-between mb-8 gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center text-xl shadow-lg shadow-indigo-500/30">
              ✅
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight">Slack TaskBot</h1>
              <p className="text-slate-500 text-sm">Task tracking &amp; follow-up for Brandon&apos;s team</p>
            </div>
          </div>
          <Link
            href="/dashboard"
            className="bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 text-white font-semibold text-sm px-5 py-2.5 rounded-xl shadow-lg shadow-indigo-500/25 transition-all"
          >
            Open Dashboard →
          </Link>
        </div>

        <div className="grid gap-4">
          <div className="bg-white/70 backdrop-blur-xl rounded-2xl p-5 border border-white/90 shadow-md shadow-indigo-100/50">
            <h2 className="font-semibold text-slate-700 mb-3">Two ways to assign a task</h2>
            <div className="space-y-3 text-sm text-slate-500">
              <div className="flex gap-2">
                <span className="text-indigo-500 font-bold shrink-0">Slack:</span>
                <span>Type <code className="bg-indigo-50 border border-indigo-100 px-1.5 rounded text-indigo-600">@TaskBot @teammate needs to do X</code> in the channel</span>
              </div>
              <div className="flex gap-2">
                <span className="text-indigo-500 font-bold shrink-0">Dashboard:</span>
                <span>Click <span className="text-slate-700 font-medium">+ New Task</span>, pick a teammate, describe the task — it posts to Slack automatically</span>
              </div>
            </div>
          </div>

          <div className="bg-white/70 backdrop-blur-xl rounded-2xl p-5 border border-white/90 shadow-md shadow-indigo-100/50">
            <h2 className="font-semibold text-slate-700 mb-3">Task lifecycle</h2>
            <ol className="space-y-2 text-sm text-slate-500">
              <li className="flex gap-2"><span className="text-indigo-500 font-bold">1.</span> Bot logs the task and follows up automatically: 24h → 24h → 12h → 6h → 4h (or push one instantly from the dashboard)</li>
              <li className="flex gap-2"><span className="text-amber-500 font-bold">2.</span> Teammate replies &quot;done&quot; → task goes to <span className="text-amber-600 font-medium">Needs Review</span> and Brandon gets a DM</li>
              <li className="flex gap-2"><span className="text-emerald-500 font-bold">3.</span> Brandon approves on the dashboard → task closed, teammate congratulated</li>
              <li className="flex gap-2"><span className="text-orange-500 font-bold">4.</span> Or Brandon requests revisions → feedback sent to the Slack thread with a real @mention, task reopens, follow-ups restart</li>
              <li className="flex gap-2"><span className="text-rose-500 font-bold">5.</span> After 5 no-responses → task escalates and Brandon is DMed directly</li>
            </ol>
          </div>

          <div className="bg-white/70 backdrop-blur-xl rounded-2xl p-5 border border-white/90 shadow-md shadow-indigo-100/50">
            <h2 className="font-semibold text-slate-700 mb-3">API Endpoints</h2>
            <div className="space-y-2 text-sm font-mono">
              <div className="flex gap-3">
                <span className="text-emerald-600">POST</span>
                <span className="text-slate-600">/api/slack/events</span>
                <span className="text-slate-400">← Slack webhook</span>
              </div>
              <div className="flex gap-3">
                <span className="text-indigo-600">GET</span>
                <span className="text-slate-600">/api/cron/followup</span>
                <span className="text-slate-400">← cron-job.org</span>
              </div>
              <div className="flex gap-3">
                <span className="text-emerald-600">POST</span>
                <span className="text-slate-600">/api/tasks</span>
                <span className="text-slate-400">← create from dashboard</span>
              </div>
              <div className="flex gap-3">
                <span className="text-indigo-600">GET</span>
                <span className="text-slate-600">/api/health</span>
                <span className="text-slate-400">← status check</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
