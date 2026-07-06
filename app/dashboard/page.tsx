import { createSupabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const STATUS_COLORS: Record<string, string> = {
  active: "bg-blue-500",
  completed: "bg-green-500",
  escalated: "bg-red-500",
  cancelled: "bg-gray-500",
};

const STATUS_LABELS: Record<string, string> = {
  active: "Active",
  completed: "Done",
  escalated: "Escalated",
  cancelled: "Cancelled",
};

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const h = Math.floor(diff / 3600000);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ago`;
  if (h > 0) return `${h}h ago`;
  return "just now";
}

function nextFollowupIn(dateStr: string | null) {
  if (!dateStr) return "—";
  const diff = new Date(dateStr).getTime() - Date.now();
  if (diff < 0) return "overdue";
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (h > 0) return `in ${h}h ${m}m`;
  return `in ${m}m`;
}

export default async function Dashboard() {
  const supabase = createSupabaseAdmin();

  const { data: tasks } = await supabase
    .from("tasks")
    .select("*, followup_logs(*)")
    .order("created_at", { ascending: false })
    .limit(100);

  const all = tasks ?? [];
  const active = all.filter(t => t.status === "active");
  const completed = all.filter(t => t.status === "completed");
  const escalated = all.filter(t => t.status === "escalated");

  return (
    <main className="min-h-screen bg-gray-950 text-white p-6">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-3 mb-8">
          <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center text-xl">📋</div>
          <div>
            <h1 className="text-2xl font-bold">Task Tracker</h1>
            <p className="text-gray-400 text-sm">Live overview — refreshes on page load</p>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-4 mb-8">
          <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
            <p className="text-gray-400 text-sm">Active</p>
            <p className="text-3xl font-bold text-blue-400">{active.length}</p>
          </div>
          <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
            <p className="text-gray-400 text-sm">Completed</p>
            <p className="text-3xl font-bold text-green-400">{completed.length}</p>
          </div>
          <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
            <p className="text-gray-400 text-sm">Escalated</p>
            <p className="text-3xl font-bold text-red-400">{escalated.length}</p>
          </div>
        </div>

        {/* Task List */}
        <div className="space-y-3">
          {all.length === 0 && (
            <div className="text-gray-500 text-center py-12">No tasks yet. Assign one in Slack!</div>
          )}
          {all.map(task => (
            <div key={task.id} className="bg-gray-900 rounded-xl p-5 border border-gray-800">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full text-white ${STATUS_COLORS[task.status] ?? "bg-gray-600"}`}>
                      {STATUS_LABELS[task.status] ?? task.status}
                    </span>
                    <span className="text-gray-500 text-xs">{timeAgo(task.created_at)}</span>
                  </div>
                  <p className="font-medium text-gray-100 truncate">{task.task_text}</p>
                  <p className="text-sm text-gray-400 mt-0.5">
                    <span className="text-gray-300">{task.assigned_to_name}</span>
                    <span className="mx-1">·</span>
                    assigned by {task.assigned_by_name}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-sm text-gray-400">
                    {task.followup_count}/{task.max_followups} follow-ups
                  </p>
                  {task.status === "active" && (
                    <p className="text-xs text-yellow-400 mt-0.5">
                      Next: {nextFollowupIn(task.next_followup_at)}
                    </p>
                  )}
                  {task.status === "completed" && task.completed_at && (
                    <p className="text-xs text-green-400 mt-0.5">
                      Completed {timeAgo(task.completed_at)}
                    </p>
                  )}
                  {task.status === "escalated" && task.escalated_at && (
                    <p className="text-xs text-red-400 mt-0.5">
                      Escalated {timeAgo(task.escalated_at)}
                    </p>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
