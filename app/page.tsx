import Link from "next/link";

export default function Home() {
  return (
    <main className="min-h-screen bg-gray-950 text-white p-8">
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center text-xl">
              ✅
            </div>
            <div>
              <h1 className="text-2xl font-bold">Slack TaskBot</h1>
              <p className="text-gray-400 text-sm">Task tracking &amp; follow-up for Brandon&apos;s team</p>
            </div>
          </div>
          <Link
            href="/dashboard"
            className="bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm px-5 py-2.5 rounded-xl transition-colors"
          >
            Open Dashboard →
          </Link>
        </div>

        <div className="grid gap-4">
          <div className="bg-gray-900 rounded-xl p-5 border border-gray-800">
            <h2 className="font-semibold text-gray-200 mb-3">Two ways to assign a task</h2>
            <div className="space-y-3 text-sm text-gray-400">
              <div className="flex gap-2">
                <span className="text-blue-400 font-bold shrink-0">Slack:</span>
                <span>Type <code className="bg-gray-800 px-1 rounded text-blue-300">@TaskBot @teammate needs to do X</code> in the channel</span>
              </div>
              <div className="flex gap-2">
                <span className="text-blue-400 font-bold shrink-0">Dashboard:</span>
                <span>Click <span className="text-gray-200 font-medium">+ New Task</span>, pick a teammate, describe the task — it posts to Slack automatically</span>
              </div>
            </div>
          </div>

          <div className="bg-gray-900 rounded-xl p-5 border border-gray-800">
            <h2 className="font-semibold text-gray-200 mb-3">Task lifecycle</h2>
            <ol className="space-y-2 text-sm text-gray-400">
              <li className="flex gap-2"><span className="text-blue-400 font-bold">1.</span> Bot logs the task and follows up automatically: 24h → 24h → 12h → 6h → 4h</li>
              <li className="flex gap-2"><span className="text-amber-400 font-bold">2.</span> Teammate replies &quot;done&quot; → task goes to <span className="text-amber-400">Needs Review</span> and Brandon gets a DM</li>
              <li className="flex gap-2"><span className="text-green-400 font-bold">3.</span> Brandon approves on the dashboard → task closed, teammate congratulated</li>
              <li className="flex gap-2"><span className="text-orange-400 font-bold">4.</span> Or Brandon requests revisions → feedback sent to the Slack thread, task reopens, follow-ups restart</li>
              <li className="flex gap-2"><span className="text-red-400 font-bold">5.</span> After 5 no-responses → task escalates and Brandon is DMed directly</li>
            </ol>
          </div>

          <div className="bg-gray-900 rounded-xl p-5 border border-gray-800">
            <h2 className="font-semibold text-gray-200 mb-3">API Endpoints</h2>
            <div className="space-y-2 text-sm font-mono">
              <div className="flex gap-3">
                <span className="text-green-400">POST</span>
                <span className="text-gray-300">/api/slack/events</span>
                <span className="text-gray-500">← Slack webhook</span>
              </div>
              <div className="flex gap-3">
                <span className="text-blue-400">GET</span>
                <span className="text-gray-300">/api/cron/followup</span>
                <span className="text-gray-500">← cron-job.org</span>
              </div>
              <div className="flex gap-3">
                <span className="text-green-400">POST</span>
                <span className="text-gray-300">/api/tasks</span>
                <span className="text-gray-500">← create from dashboard</span>
              </div>
              <div className="flex gap-3">
                <span className="text-blue-400">GET</span>
                <span className="text-gray-300">/api/health</span>
                <span className="text-gray-500">← status check</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
