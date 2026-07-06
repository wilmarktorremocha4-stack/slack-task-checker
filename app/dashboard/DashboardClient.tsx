"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { Task, TaskComment } from "@/lib/supabase";

type TaskWithComments = Task & { task_comments: TaskComment[] };
type SlackUser = { id: string; name: string };
type ToastType = { id: number; message: string; ok: boolean };

const STATUS = {
  active:             { label: "Active",         bg: "bg-blue-500",   text: "text-blue-400",   border: "border-blue-500/30" },
  pending_review:     { label: "Needs Review",   bg: "bg-amber-500",  text: "text-amber-400",  border: "border-amber-500/40" },
  revision_requested: { label: "Revision Sent",  bg: "bg-orange-500", text: "text-orange-400", border: "border-orange-500/30" },
  completed:          { label: "Done",            bg: "bg-green-500",  text: "text-green-400",  border: "border-green-500/20" },
  escalated:          { label: "Escalated",       bg: "bg-red-500",    text: "text-red-400",    border: "border-red-500/30" },
  cancelled:          { label: "Cancelled",       bg: "bg-gray-500",   text: "text-gray-500",   border: "border-gray-700" },
} as const;

const FILTERS = [
  { key: "all",               label: "All" },
  { key: "pending_review",    label: "Needs Review" },
  { key: "active",            label: "Active" },
  { key: "revision_requested",label: "Revision Sent" },
  { key: "completed",         label: "Done" },
  { key: "escalated",         label: "Escalated" },
  { key: "cancelled",         label: "Cancelled" },
];

function timeAgo(d: string) {
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function nextIn(d: string | null) {
  if (!d) return null;
  const diff = new Date(d).getTime() - Date.now();
  if (diff < 0) return "overdue";
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  return h > 0 ? `in ${h}h ${m}m` : `in ${m}m`;
}

function sortTasks(tasks: TaskWithComments[]) {
  const order = ["pending_review", "revision_requested", "active", "escalated", "completed", "cancelled"];
  return [...tasks].sort((a, b) => {
    const ai = order.indexOf(a.status);
    const bi = order.indexOf(b.status);
    if (ai !== bi) return ai - bi;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
}

// ── Toast ────────────────────────────────────────────────────────────────────

function Toast({ toasts }: { toasts: ToastType[] }) {
  if (!toasts.length) return null;
  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map(t => (
        <div
          key={t.id}
          className={`px-4 py-3 rounded-xl text-sm font-medium shadow-xl border backdrop-blur ${
            t.ok
              ? "bg-green-900/90 border-green-700 text-green-200"
              : "bg-red-900/90 border-red-700 text-red-200"
          }`}
        >
          {t.ok ? "✓" : "✗"} {t.message}
        </div>
      ))}
    </div>
  );
}

// ── Comment bubble ───────────────────────────────────────────────────────────

function CommentBubble({ c }: { c: TaskComment }) {
  if (c.author_type === "system") {
    return (
      <div className="flex justify-center my-1">
        <span className="text-xs text-gray-500 italic px-3 py-1 bg-gray-800/60 rounded-full">
          {c.content} · {timeAgo(c.created_at)}
        </span>
      </div>
    );
  }
  const isBrandon = c.author_type === "brandon";
  return (
    <div className={`flex gap-2 ${isBrandon ? "flex-row-reverse" : "flex-row"}`}>
      <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
        isBrandon ? "bg-blue-600 text-white" : "bg-gray-600 text-gray-200"
      }`}>
        {c.author_name.charAt(0).toUpperCase()}
      </div>
      <div className={`max-w-[75%] ${isBrandon ? "items-end" : "items-start"} flex flex-col`}>
        <span className="text-xs text-gray-500 mb-1 px-1">
          {c.author_name} · {timeAgo(c.created_at)}
        </span>
        <div className={`px-3 py-2 rounded-2xl text-sm leading-relaxed ${
          isBrandon
            ? "bg-blue-600 text-white rounded-tr-sm"
            : "bg-gray-700 text-gray-100 rounded-tl-sm"
        }`}>
          {c.content}
        </div>
      </div>
    </div>
  );
}

// ── Task Card ────────────────────────────────────────────────────────────────

function TaskCard({
  task,
  expanded,
  onToggle,
  onAction,
}: {
  task: TaskWithComments;
  expanded: boolean;
  onToggle: () => void;
  onAction: (taskId: string, action: "approve" | "cancel" | "revision", content?: string) => Promise<void>;
}) {
  const [revisionText, setRevisionText] = useState("");
  const [working, setWorking] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);
  const cfg = STATUS[task.status] ?? STATUS.active;
  const isPendingReview = task.status === "pending_review";
  const isOpen = task.status === "active" || task.status === "revision_requested";

  useEffect(() => {
    if (expanded && threadRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }
  }, [expanded, task.task_comments]);

  async function handle(action: "approve" | "cancel" | "revision") {
    if (action === "revision" && !revisionText.trim()) return;
    setWorking(true);
    await onAction(task.id, action, action === "revision" ? revisionText : undefined);
    if (action === "revision") setRevisionText("");
    setWorking(false);
  }

  const sortedComments = [...(task.task_comments ?? [])].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );

  return (
    <div
      className={`rounded-xl border transition-all duration-200 ${
        isPendingReview
          ? "border-amber-500/50 bg-amber-950/20 shadow-amber-900/20 shadow-lg"
          : `${cfg.border} bg-gray-900`
      }`}
    >
      {/* Card header — always visible */}
      <button
        onClick={onToggle}
        className="w-full text-left p-5 flex items-start gap-4 hover:bg-white/[0.02] rounded-xl transition-colors"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full text-white ${cfg.bg}`}>
              {cfg.label}
            </span>
            {isPendingReview && (
              <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/30 animate-pulse">
                Awaiting your review
              </span>
            )}
            <span className="text-gray-500 text-xs">{timeAgo(task.created_at)}</span>
          </div>
          <p className="font-medium text-gray-100 leading-snug">{task.task_text}</p>
          <p className="text-sm text-gray-400 mt-1">
            <span className="text-gray-300">{task.assigned_to_name}</span>
            <span className="mx-1 text-gray-600">·</span>
            assigned by {task.assigned_by_name}
          </p>
        </div>

        <div className="text-right shrink-0 flex flex-col items-end gap-1">
          <span className="text-xs text-gray-500">
            {task.followup_count}/{task.max_followups} follow-ups
          </span>
          {isOpen && task.next_followup_at && (
            <span className={`text-xs ${nextIn(task.next_followup_at) === "overdue" ? "text-red-400" : "text-yellow-400"}`}>
              Next: {nextIn(task.next_followup_at)}
            </span>
          )}
          {task.status === "completed" && task.completed_at && (
            <span className="text-xs text-green-400">Completed {timeAgo(task.completed_at)}</span>
          )}
          {task.status === "escalated" && task.escalated_at && (
            <span className="text-xs text-red-400">Escalated {timeAgo(task.escalated_at)}</span>
          )}
          <span className="text-gray-600 text-xs mt-1">{expanded ? "▲" : "▼"}</span>
        </div>
      </button>

      {/* Expanded thread + actions */}
      {expanded && (
        <div className="border-t border-gray-800 px-5 pb-5 pt-4">
          {/* Comment thread */}
          {sortedComments.length > 0 ? (
            <div
              ref={threadRef}
              className="flex flex-col gap-3 max-h-72 overflow-y-auto mb-4 pr-1 scrollbar-thin"
            >
              {sortedComments.map(c => (
                <CommentBubble key={c.id} c={c} />
              ))}
            </div>
          ) : (
            <p className="text-sm text-gray-600 italic mb-4 text-center py-3">
              No messages yet — thread activity will appear here.
            </p>
          )}

          {/* Actions for pending_review */}
          {isPendingReview && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm text-amber-400 font-medium">
                <span>👀</span>
                <span>{task.assigned_to_name} says this is done. Approve or send revisions.</span>
              </div>
              <textarea
                value={revisionText}
                onChange={e => setRevisionText(e.target.value)}
                placeholder="Describe what needs to be changed or fixed..."
                className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-orange-500 resize-none"
                rows={3}
              />
              <div className="flex gap-3">
                <button
                  disabled={working}
                  onClick={() => handle("approve")}
                  className="flex-1 bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white font-semibold text-sm py-2.5 rounded-xl transition-colors"
                >
                  {working ? "..." : "✅ Approve & Close"}
                </button>
                <button
                  disabled={working || !revisionText.trim()}
                  onClick={() => handle("revision")}
                  className="flex-1 bg-orange-600 hover:bg-orange-500 disabled:opacity-50 text-white font-semibold text-sm py-2.5 rounded-xl transition-colors"
                >
                  {working ? "..." : "📝 Request Revision"}
                </button>
              </div>
              <button
                disabled={working}
                onClick={() => handle("cancel")}
                className="w-full text-xs text-gray-500 hover:text-red-400 py-1.5 transition-colors"
              >
                Cancel this task
              </button>
            </div>
          )}

          {/* Actions for open tasks (active / revision_requested) */}
          {isOpen && (
            <div className="space-y-3">
              <p className="text-xs text-gray-500 text-center">
                Waiting for {task.assigned_to_name} to respond. Follow-ups are running automatically.
              </p>
              <button
                disabled={working}
                onClick={() => handle("cancel")}
                className="w-full text-xs text-gray-500 hover:text-red-400 py-1.5 transition-colors"
              >
                Cancel this task
              </button>
            </div>
          )}

          {/* Read-only for closed statuses */}
          {(task.status === "completed" || task.status === "escalated" || task.status === "cancelled") && (
            <p className="text-xs text-gray-600 text-center italic py-2">
              This task is closed.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ── New Task Modal ───────────────────────────────────────────────────────────

function NewTaskModal({
  onClose,
  onCreated,
  toast,
}: {
  onClose: () => void;
  onCreated: () => void;
  toast: (msg: string, ok: boolean) => void;
}) {
  const [users, setUsers] = useState<SlackUser[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [assigneeId, setAssigneeId] = useState("");
  const [taskText, setTaskText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [userSearch, setUserSearch] = useState("");

  useEffect(() => {
    fetch("/api/slack/users")
      .then(r => r.json())
      .then(d => setUsers(d.members ?? []))
      .catch(() => setUsers([]))
      .finally(() => setLoadingUsers(false));
  }, []);

  const filteredUsers = userSearch
    ? users.filter(u => u.name.toLowerCase().includes(userSearch.toLowerCase()))
    : users;

  const selectedUser = users.find(u => u.id === assigneeId);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!assigneeId || !taskText.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assigneeId, assigneeName: selectedUser?.name ?? assigneeId, taskText }),
      });
      if (res.ok) {
        toast("Task created and posted to Slack", true);
        onCreated();
        onClose();
      } else {
        const d = await res.json();
        toast(d.error ?? "Failed to create task", false);
      }
    } catch {
      toast("Network error — please try again", false);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-40 flex items-center justify-center p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-lg shadow-2xl">
        <div className="flex items-center justify-between p-6 border-b border-gray-800">
          <h2 className="text-lg font-semibold text-gray-100">Assign New Task</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-xl leading-none">×</button>
        </div>

        <form onSubmit={submit} className="p-6 space-y-5">
          {/* Assignee */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">Assign to</label>
            {loadingUsers ? (
              <div className="text-sm text-gray-500 py-2">Loading team members...</div>
            ) : (
              <div className="space-y-2">
                <input
                  type="text"
                  placeholder="Search team members..."
                  value={userSearch}
                  onChange={e => setUserSearch(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
                />
                <div className="max-h-40 overflow-y-auto bg-gray-800 border border-gray-700 rounded-xl divide-y divide-gray-700/50">
                  {filteredUsers.length === 0 && (
                    <p className="text-sm text-gray-500 p-3 text-center">No members found</p>
                  )}
                  {filteredUsers.map(u => (
                    <button
                      key={u.id}
                      type="button"
                      onClick={() => { setAssigneeId(u.id); setUserSearch(""); }}
                      className={`w-full text-left px-4 py-2.5 text-sm transition-colors ${
                        assigneeId === u.id
                          ? "bg-blue-600 text-white"
                          : "text-gray-300 hover:bg-gray-700"
                      }`}
                    >
                      {u.name}
                    </button>
                  ))}
                </div>
                {selectedUser && (
                  <p className="text-xs text-blue-400">
                    Selected: <span className="font-medium">{selectedUser.name}</span>
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Task text */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">Task description</label>
            <textarea
              required
              value={taskText}
              onChange={e => setTaskText(e.target.value)}
              placeholder="e.g. Prepare the supplier outreach plan by Friday"
              className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-none"
              rows={4}
            />
          </div>

          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-300 font-medium text-sm py-3 rounded-xl transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!assigneeId || !taskText.trim() || submitting}
              className="flex-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-semibold text-sm py-3 rounded-xl transition-colors"
            >
              {submitting ? "Posting to Slack..." : "Assign Task"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Main Dashboard ───────────────────────────────────────────────────────────

export default function DashboardClient({ initialTasks }: { initialTasks: TaskWithComments[] }) {
  const [tasks, setTasks] = useState<TaskWithComments[]>(sortTasks(initialTasks));
  const [filter, setFilter] = useState("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(new Date());
  const [toasts, setToasts] = useState<ToastType[]>([]);
  const toastIdRef = useRef(0);

  function addToast(message: string, ok: boolean) {
    const id = ++toastIdRef.current;
    setToasts(prev => [...prev, { id, message, ok }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  }

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/dashboard/tasks");
      if (!res.ok) return;
      const { tasks: fresh } = await res.json();
      setTasks(sortTasks(fresh));
      setLastRefresh(new Date());
    } catch {
      // silent fail — UI retains previous data
    }
  }, []);

  // Auto-refresh every 30s
  useEffect(() => {
    const timer = setInterval(refresh, 30_000);
    return () => clearInterval(timer);
  }, [refresh]);

  async function handleAction(
    taskId: string,
    action: "approve" | "cancel" | "revision",
    content?: string
  ) {
    try {
      let res: Response;
      if (action === "approve" || action === "cancel") {
        res = await fetch(`/api/tasks/${taskId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action }),
        });
      } else {
        res = await fetch(`/api/tasks/${taskId}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content }),
        });
      }

      if (res.ok) {
        const msgs = {
          approve: "Task approved and closed",
          cancel: "Task cancelled",
          revision: "Revision sent to Slack",
        };
        addToast(msgs[action], true);
        await refresh();
      } else {
        const d = await res.json();
        addToast(d.error ?? "Something went wrong", false);
      }
    } catch {
      addToast("Network error — please try again", false);
    }
  }

  const counts = {
    all: tasks.length,
    active: tasks.filter(t => t.status === "active").length,
    pending_review: tasks.filter(t => t.status === "pending_review").length,
    revision_requested: tasks.filter(t => t.status === "revision_requested").length,
    completed: tasks.filter(t => t.status === "completed").length,
    escalated: tasks.filter(t => t.status === "escalated").length,
    cancelled: tasks.filter(t => t.status === "cancelled").length,
  } as Record<string, number>;

  const visible = filter === "all" ? tasks : tasks.filter(t => t.status === filter);

  return (
    <main className="min-h-screen bg-gray-950 text-white">
      <Toast toasts={toasts} />
      {newTaskOpen && (
        <NewTaskModal
          onClose={() => setNewTaskOpen(false)}
          onCreated={refresh}
          toast={addToast}
        />
      )}

      <div className="max-w-4xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center text-xl">📋</div>
            <div>
              <h1 className="text-2xl font-bold">Task Tracker</h1>
              <p className="text-gray-500 text-xs">
                Updated {timeAgo(lastRefresh.toISOString())}
                <button onClick={refresh} className="ml-2 text-blue-500 hover:text-blue-400 underline underline-offset-2">
                  Refresh
                </button>
              </p>
            </div>
          </div>
          <button
            onClick={() => setNewTaskOpen(true)}
            className="bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm px-5 py-2.5 rounded-xl transition-colors flex items-center gap-2"
          >
            <span className="text-base">+</span> New Task
          </button>
        </div>

        {/* Stats bar */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-6">
          {[
            { label: "Active",       count: counts.active,             color: "text-blue-400" },
            { label: "Needs Review", count: counts.pending_review,     color: "text-amber-400" },
            { label: "Revision",     count: counts.revision_requested, color: "text-orange-400" },
            { label: "Done",         count: counts.completed,          color: "text-green-400" },
            { label: "Escalated",    count: counts.escalated,          color: "text-red-400" },
          ].map(s => (
            <div key={s.label} className="bg-gray-900 rounded-xl p-4 border border-gray-800 text-center">
              <p className="text-gray-500 text-xs mb-1">{s.label}</p>
              <p className={`text-2xl font-bold ${s.color}`}>{s.count}</p>
            </div>
          ))}
        </div>

        {/* Filter tabs */}
        <div className="flex gap-1 mb-5 overflow-x-auto pb-1 scrollbar-none">
          {FILTERS.map(f => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`shrink-0 px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-1.5 ${
                filter === f.key
                  ? "bg-gray-700 text-white"
                  : "text-gray-400 hover:text-gray-200 hover:bg-gray-800/60"
              }`}
            >
              {f.label}
              {counts[f.key] > 0 && (
                <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                  filter === f.key ? "bg-gray-600 text-gray-200" : "bg-gray-800 text-gray-500"
                }`}>
                  {counts[f.key]}
                </span>
              )}
              {f.key === "pending_review" && counts.pending_review > 0 && (
                <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
              )}
            </button>
          ))}
        </div>

        {/* Task list */}
        <div className="space-y-3">
          {visible.length === 0 && (
            <div className="text-center text-gray-600 py-16">
              {filter === "all" ? "No tasks yet. Create one above!" : `No ${filter.replace("_", " ")} tasks.`}
            </div>
          )}
          {visible.map(task => (
            <TaskCard
              key={task.id}
              task={task}
              expanded={expandedId === task.id}
              onToggle={() => setExpandedId(expandedId === task.id ? null : task.id)}
              onAction={handleAction}
            />
          ))}
        </div>
      </div>
    </main>
  );
}
