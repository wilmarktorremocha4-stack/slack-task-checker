export default function Home() {
  return (
    <main className="min-h-screen bg-gray-950 text-white p-8">
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center gap-3 mb-8">
          <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center text-xl">
            ✅
          </div>
          <div>
            <h1 className="text-2xl font-bold">Slack TaskBot</h1>
            <p className="text-gray-400 text-sm">Automated task follow-up for Brandon&apos;s team</p>
          </div>
        </div>

        <div className="grid gap-4">
          <div className="bg-gray-900 rounded-xl p-5 border border-gray-800">
            <h2 className="font-semibold text-gray-200 mb-3">How it works</h2>
            <ol className="space-y-2 text-sm text-gray-400">
              <li className="flex gap-2"><span className="text-blue-400 font-bold">1.</span> Brandon types <code className="bg-gray-800 px-1 rounded text-blue-300">@TaskBot @will needs to do X</code></li>
              <li className="flex gap-2"><span className="text-blue-400 font-bold">2.</span> Bot logs the task and confirms in the thread</li>
              <li className="flex gap-2"><span className="text-blue-400 font-bold">3.</span> Bot follows up automatically: 24h → 24h → 12h → 6h → 4h</li>
              <li className="flex gap-2"><span className="text-blue-400 font-bold">4.</span> Person replies &quot;done&quot; → bot stops and celebrates</li>
              <li className="flex gap-2"><span className="text-blue-400 font-bold">5.</span> After 5 no-responses → DMs Brandon directly</li>
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
                <span className="text-blue-400">GET</span>
                <span className="text-gray-300">/api/health</span>
                <span className="text-gray-500">← status check</span>
              </div>
              <div className="flex gap-3">
                <span className="text-blue-400">GET</span>
                <span className="text-gray-300">/api/tasks</span>
                <span className="text-gray-500">← task list</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
