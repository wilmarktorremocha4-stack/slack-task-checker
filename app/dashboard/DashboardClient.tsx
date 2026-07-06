"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { createSupabaseBrowser } from "@/lib/supabase-browser";
import type { Task, TaskComment } from "@/lib/supabase";

type TaskWithComments = Task & { task_comments: TaskComment[] };
type SlackUser = { id: string; name: string };
type ToastType = { id: number; message: string; ok: boolean };

const STATUS = {
  active:             { label: "Active",        badge: "bg-indigo-100 text-indigo-700 border-indigo-200",  dot: "bg-indigo-500" },
  pending_review:     { label: "Needs Review",  badge: "bg-amber-100 text-amber-700 border-amber-200",     dot: "bg-amber-500" },
  revision_requested: { label: "Revision Sent", badge: "bg-orange-100 text-orange-700 border-orange-200",  dot: "bg-orange-500" },
  completed:          { label: "Done",          badge: "bg-emerald-100 text-emerald-700 border-emerald-200", dot: "bg-emerald-500" },
  escalated:          { label: "Escalated",     badge: "bg-rose-100 text-rose-700 border-rose-200",        dot: "bg-rose-500" },
  cancelled:          { label: "Cancelled",     badge: "bg-slate-100 text-slate-500 border-slate-200",     dot: "bg-slate-400" },
} as const;

const FILTERS = [
  { key: "all",                label: "All" },
  { key: "pending_review",     label: "Needs Review" },
  { key: "active",             label: "Active" },
  { key: "revision_requested", label: "Revision Sent" },
  { key: "completed",          label: "Done" },
  { key: "escalated",          label: "Escalated" },
  { key: "cancelled",          label: "Cancelled" },
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

// ── Icons (inline, no deps) ─────────────────────────────────────────────────

function IconRefresh({ spinning }: { spinning?: boolean }) {
  return (
    <svg className={`w-4 h-4 ${spinning ? "animate-spin" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

function IconBolt() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
      <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function IconEdit() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    </svg>
  );
}

function IconTrash() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    </svg>
  );
}

function IconPlus() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function IconLogout() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
    </svg>
  );
}

// ── Toast ───────────────────────────────────────────────────────────────────

function Toast({ toasts }: { toasts: ToastType[] }) {
  if (!toasts.length) return null;
  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map(t => (
        <div
          key={t.id}
          className={`px-4 py-3 rounded-xl text-sm font-medium shadow-lg border backdrop-blur-xl ${
            t.ok
              ? "bg-emerald-50/95 border-emerald-200 text-emerald-700"
              : "bg-rose-50/95 border-rose-200 text-rose-700"
          }`}
        >
          {t.ok ? "✓" : "✗"} {t.message}
        </div>
      ))}
    </div>
  );
}

// ── Confirm dialog ──────────────────────────────────────────────────────────

function ConfirmDialog({
  title,
  body,
  confirmLabel,
  danger,
  onConfirm,
  onClose,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  // Portal to <body> — ancestors with backdrop-filter would otherwise trap the fixed overlay
  return createPortal(
    <div className="fixed inset-0 bg-slate-900/30 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white/90 backdrop-blur-xl border border-white rounded-2xl w-full max-w-sm shadow-2xl shadow-indigo-200/50 p-6">
        <h3 className="text-base font-semibold text-slate-800 mb-2">{title}</h3>
        <p className="text-sm text-slate-500 mb-6 leading-relaxed">{body}</p>
        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 bg-white border border-slate-200 hover:bg-slate-50 text-slate-600 font-medium text-sm py-2.5 rounded-xl transition-colors"
          >
            Keep as is
          </button>
          <button
            onClick={() => { onConfirm(); onClose(); }}
            className={`flex-1 font-semibold text-sm py-2.5 rounded-xl text-white transition-all active:scale-[0.98] shadow-lg ${
              danger
                ? "bg-rose-500 hover:bg-rose-600 shadow-rose-500/25"
                : "bg-indigo-500 hover:bg-indigo-600 shadow-indigo-500/25"
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ── Comment bubble ──────────────────────────────────────────────────────────

function CommentBubble({ c }: { c: TaskComment }) {
  if (c.author_type === "system") {
    return (
      <div className="flex justify-center my-1">
        <span className="text-xs text-slate-400 italic px-3 py-1 bg-slate-100/80 rounded-full text-center">
          {c.content} · {timeAgo(c.created_at)}
        </span>
      </div>
    );
  }
  const isBrandon = c.author_type === "brandon";
  return (
    <div className={`flex gap-2 ${isBrandon ? "flex-row-reverse" : "flex-row"}`}>
      <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
        isBrandon
          ? "bg-gradient-to-br from-indigo-500 to-violet-600 text-white"
          : "bg-slate-200 text-slate-600"
      }`}>
        {c.author_name.charAt(0).toUpperCase()}
      </div>
      <div className={`max-w-[75%] ${isBrandon ? "items-end" : "items-start"} flex flex-col`}>
        <span className="text-xs text-slate-400 mb-1 px-1">
          {c.author_name} · {timeAgo(c.created_at)}
        </span>
        <div className={`px-3.5 py-2 rounded-2xl text-sm leading-relaxed ${
          isBrandon
            ? "bg-gradient-to-br from-indigo-500 to-violet-600 text-white rounded-tr-sm shadow-md shadow-indigo-500/20"
            : "bg-white border border-slate-200 text-slate-700 rounded-tl-sm shadow-sm"
        }`}>
          {c.content}
        </div>
      </div>
    </div>
  );
}

// ── Task Card ───────────────────────────────────────────────────────────────

function TaskCard({
  task,
  expanded,
  onToggle,
  onAction,
}: {
  task: TaskWithComments;
  expanded: boolean;
  onToggle: () => void;
  onAction: (taskId: string, action: "approve" | "cancel" | "revision" | "followup_now", content?: string) => Promise<void>;
}) {
  const [revisionText, setRevisionText] = useState("");
  const [working, setWorking] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"cancel" | "followup_now" | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const cfg = STATUS[task.status] ?? STATUS.active;
  const isPendingReview = task.status === "pending_review";
  const isOpen = task.status === "active" || task.status === "revision_requested";

  useEffect(() => {
    if (expanded && threadRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }
  }, [expanded, task.task_comments]);

  async function handle(action: "approve" | "cancel" | "revision" | "followup_now") {
    if (action === "revision" && !revisionText.trim()) return;
    setWorking(action);
    await onAction(task.id, action, action === "revision" ? revisionText : undefined);
    if (action === "revision") setRevisionText("");
    setWorking(null);
  }

  const sortedComments = [...(task.task_comments ?? [])].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );

  const followupsLeft = task.max_followups - task.followup_count;

  return (
    <div
      className={`rounded-2xl border transition-all duration-200 bg-white/70 backdrop-blur-xl ${
        isPendingReview
          ? "border-amber-300 shadow-lg shadow-amber-200/40 ring-1 ring-amber-200"
          : "border-white/90 shadow-md shadow-indigo-100/50"
      }`}
    >
      {confirm === "cancel" && (
        <ConfirmDialog
          title="Cancel this task?"
          body={`${task.assigned_to_name} will be notified in Slack that the task is cancelled, and all follow-ups will stop. This cannot be undone.`}
          confirmLabel="Yes, cancel task"
          danger
          onConfirm={() => handle("cancel")}
          onClose={() => setConfirm(null)}
        />
      )}
      {confirm === "followup_now" && (
        <ConfirmDialog
          title="Send a follow-up right now?"
          body={
            followupsLeft > 0
              ? `This sends follow-up #${task.followup_count + 1} of ${task.max_followups} to ${task.assigned_to_name} in Slack immediately, instead of waiting for the scheduled time.`
              : `All ${task.max_followups} follow-ups are used. Sending now will ESCALATE the task and DM Brandon.`
          }
          confirmLabel={followupsLeft > 0 ? "Send follow-up" : "Escalate now"}
          danger={followupsLeft <= 0}
          onConfirm={() => handle("followup_now")}
          onClose={() => setConfirm(null)}
        />
      )}

      {/* Card header — always visible */}
      <button
        onClick={onToggle}
        className="w-full text-left p-5 flex items-start gap-4 hover:bg-indigo-50/40 rounded-2xl transition-colors"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5 flex-wrap">
            <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-0.5 rounded-full border ${cfg.badge}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot} ${isPendingReview ? "animate-pulse" : ""}`} />
              {cfg.label}
            </span>
            {isPendingReview && (
              <span className="text-xs font-medium text-amber-600">Awaiting your review</span>
            )}
            <span className="text-slate-400 text-xs">{timeAgo(task.created_at)}</span>
          </div>
          <p className="font-medium text-slate-800 leading-snug">{task.task_text}</p>
          <p className="text-sm text-slate-500 mt-1">
            <span className="text-slate-600 font-medium">{task.assigned_to_name}</span>
            <span className="mx-1 text-slate-300">·</span>
            assigned by {task.assigned_by_name}
          </p>
        </div>

        <div className="text-right shrink-0 flex flex-col items-end gap-1">
          <span className="text-xs text-slate-400">
            {task.followup_count}/{task.max_followups} follow-ups
          </span>
          {isOpen && task.next_followup_at && (
            <span className={`text-xs font-medium ${nextIn(task.next_followup_at) === "overdue" ? "text-rose-500" : "text-indigo-500"}`}>
              Next: {nextIn(task.next_followup_at)}
            </span>
          )}
          {task.status === "completed" && task.completed_at && (
            <span className="text-xs text-emerald-600">Completed {timeAgo(task.completed_at)}</span>
          )}
          {task.status === "escalated" && task.escalated_at && (
            <span className="text-xs text-rose-500">Escalated {timeAgo(task.escalated_at)}</span>
          )}
          <svg
            className={`w-4 h-4 text-slate-300 mt-1 transition-transform ${expanded ? "rotate-180" : ""}`}
            viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </div>
      </button>

      {/* Expanded thread + actions */}
      {expanded && (
        <div className="border-t border-slate-100 px-5 pb-5 pt-4">
          {/* Conversation thread */}
          {sortedComments.length > 0 ? (
            <div
              ref={threadRef}
              className="flex flex-col gap-3 max-h-72 overflow-y-auto mb-4 pr-1"
            >
              {sortedComments.map(c => (
                <CommentBubble key={c.id} c={c} />
              ))}
            </div>
          ) : (
            <p className="text-sm text-slate-400 italic mb-4 text-center py-3">
              No messages yet — thread activity will appear here.
            </p>
          )}

          {/* Actions for pending_review */}
          {isPendingReview && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm text-amber-600 font-medium bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5">
                <span>👀</span>
                <span>{task.assigned_to_name} says this is done. Approve it, or describe what needs revising.</span>
              </div>
              <textarea
                value={revisionText}
                onChange={e => setRevisionText(e.target.value)}
                placeholder="Describe what needs to be changed or fixed..."
                className="w-full bg-white border border-slate-200 rounded-xl px-4 py-3 text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-orange-300/60 focus:border-orange-300 resize-none"
                rows={3}
              />
              <div className="flex gap-3">
                <button
                  disabled={!!working}
                  onClick={() => handle("approve")}
                  className="flex-1 inline-flex items-center justify-center gap-2 bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50 text-white font-semibold text-sm py-2.5 rounded-xl shadow-lg shadow-emerald-500/25 transition-all active:scale-[0.98]"
                >
                  <IconCheck /> {working === "approve" ? "Approving..." : "Approve & Close"}
                </button>
                <button
                  disabled={!!working || !revisionText.trim()}
                  onClick={() => handle("revision")}
                  className="flex-1 inline-flex items-center justify-center gap-2 bg-orange-500 hover:bg-orange-600 disabled:opacity-50 text-white font-semibold text-sm py-2.5 rounded-xl shadow-lg shadow-orange-500/25 transition-all active:scale-[0.98]"
                >
                  <IconEdit /> {working === "revision" ? "Sending..." : "Request Revision"}
                </button>
              </div>
              <button
                disabled={!!working}
                onClick={() => setConfirm("cancel")}
                className="w-full inline-flex items-center justify-center gap-2 bg-white border border-rose-200 hover:bg-rose-50 text-rose-500 font-medium text-sm py-2.5 rounded-xl transition-colors disabled:opacity-50"
              >
                <IconTrash /> Cancel Task
              </button>
            </div>
          )}

          {/* Actions for open tasks (active / revision_requested) */}
          {isOpen && (
            <div className="space-y-3">
              <p className="text-xs text-slate-400 text-center">
                Waiting for {task.assigned_to_name} to respond. Follow-ups are running automatically.
              </p>
              <div className="flex gap-3">
                <button
                  disabled={!!working}
                  onClick={() => setConfirm("followup_now")}
                  className="flex-1 inline-flex items-center justify-center gap-2 bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 disabled:opacity-50 text-white font-semibold text-sm py-2.5 rounded-xl shadow-lg shadow-indigo-500/25 transition-all active:scale-[0.98]"
                >
                  <IconBolt /> {working === "followup_now" ? "Sending..." : "Send Follow-up Now"}
                </button>
                <button
                  disabled={!!working}
                  onClick={() => setConfirm("cancel")}
                  className="flex-1 inline-flex items-center justify-center gap-2 bg-white border border-rose-200 hover:bg-rose-50 text-rose-500 font-medium text-sm py-2.5 rounded-xl transition-colors disabled:opacity-50"
                >
                  <IconTrash /> {working === "cancel" ? "Cancelling..." : "Cancel Task"}
                </button>
              </div>
            </div>
          )}

          {/* Read-only for closed statuses */}
          {(task.status === "completed" || task.status === "escalated" || task.status === "cancelled") && (
            <p className="text-xs text-slate-400 text-center italic py-2">
              This task is closed.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ── New Task Modal ──────────────────────────────────────────────────────────

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
    fetch("/api/slack/users", { cache: "no-store" })
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
    <div className="fixed inset-0 bg-slate-900/30 backdrop-blur-sm z-40 flex items-center justify-center p-4">
      <div className="bg-white/90 backdrop-blur-xl border border-white rounded-3xl w-full max-w-lg shadow-2xl shadow-indigo-200/50">
        <div className="flex items-center justify-between p-6 border-b border-slate-100">
          <h2 className="text-lg font-semibold text-slate-800">Assign New Task</h2>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-slate-100 hover:bg-slate-200 text-slate-500 flex items-center justify-center transition-colors"
            aria-label="Close"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={submit} className="p-6 space-y-5">
          {/* Assignee */}
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-2">Assign to</label>
            {loadingUsers ? (
              <div className="text-sm text-slate-400 py-2">Loading team members...</div>
            ) : (
              <div className="space-y-2">
                <input
                  type="text"
                  placeholder="Search team members..."
                  value={userSearch}
                  onChange={e => setUserSearch(e.target.value)}
                  className="w-full bg-white border border-slate-200 rounded-xl px-4 py-2.5 text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-300/60 focus:border-indigo-300"
                />
                <div className="max-h-40 overflow-y-auto bg-white border border-slate-200 rounded-xl divide-y divide-slate-100">
                  {filteredUsers.length === 0 && (
                    <p className="text-sm text-slate-400 p-3 text-center">No members found</p>
                  )}
                  {filteredUsers.map(u => (
                    <button
                      key={u.id}
                      type="button"
                      onClick={() => { setAssigneeId(u.id); setUserSearch(""); }}
                      className={`w-full text-left px-4 py-2.5 text-sm transition-colors ${
                        assigneeId === u.id
                          ? "bg-indigo-500 text-white"
                          : "text-slate-600 hover:bg-indigo-50"
                      }`}
                    >
                      {u.name}
                    </button>
                  ))}
                </div>
                {selectedUser && (
                  <p className="text-xs text-indigo-500">
                    Selected: <span className="font-semibold">{selectedUser.name}</span>
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Task text */}
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-2">Task description</label>
            <textarea
              required
              value={taskText}
              onChange={e => setTaskText(e.target.value)}
              placeholder="e.g. Prepare the supplier outreach plan by Friday"
              className="w-full bg-white border border-slate-200 rounded-xl px-4 py-3 text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-300/60 focus:border-indigo-300 resize-none"
              rows={4}
            />
          </div>

          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 bg-white border border-slate-200 hover:bg-slate-50 text-slate-600 font-medium text-sm py-3 rounded-xl transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!assigneeId || !taskText.trim() || submitting}
              className="flex-1 bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 disabled:opacity-50 text-white font-semibold text-sm py-3 rounded-xl shadow-lg shadow-indigo-500/25 transition-all active:scale-[0.98]"
            >
              {submitting ? "Posting to Slack..." : "Assign Task"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Main Dashboard ──────────────────────────────────────────────────────────

export default function DashboardClient({
  initialTasks,
  userEmail,
}: {
  initialTasks: TaskWithComments[];
  userEmail?: string | null;
}) {
  const router = useRouter();
  const [tasks, setTasks] = useState<TaskWithComments[]>(sortTasks(initialTasks));
  const [filter, setFilter] = useState("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(new Date());
  const [refreshing, setRefreshing] = useState(false);
  const [toasts, setToasts] = useState<ToastType[]>([]);
  const toastIdRef = useRef(0);

  const addToast = useCallback((message: string, ok: boolean) => {
    const id = ++toastIdRef.current;
    setToasts(prev => [...prev, { id, message, ok }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  }, []);

  const refresh = useCallback(async (opts?: { silent?: boolean }) => {
    setRefreshing(true);
    try {
      const res = await fetch("/api/dashboard/tasks", { cache: "no-store" });
      if (!res.ok) {
        if (!opts?.silent) addToast("Could not refresh — please try again", false);
        return;
      }
      const { tasks: fresh } = await res.json();
      setTasks(sortTasks(fresh));
      setLastRefresh(new Date());
    } catch {
      if (!opts?.silent) addToast("Network error while refreshing", false);
    } finally {
      setRefreshing(false);
    }
  }, [addToast]);

  // Auto-refresh every 30s
  useEffect(() => {
    const timer = setInterval(() => refresh({ silent: true }), 30_000);
    return () => clearInterval(timer);
  }, [refresh]);

  async function signOut() {
    const supabase = createSupabaseBrowser();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  async function handleAction(
    taskId: string,
    action: "approve" | "cancel" | "revision" | "followup_now",
    content?: string
  ) {
    try {
      let res: Response;
      if (action === "revision") {
        res = await fetch(`/api/tasks/${taskId}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content }),
        });
      } else {
        res = await fetch(`/api/tasks/${taskId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action }),
        });
      }

      if (res.ok) {
        const msgs = {
          approve: "Task approved and closed",
          cancel: "Task cancelled — assignee notified in Slack",
          revision: "Revision sent to the Slack thread",
          followup_now: "Follow-up sent to Slack",
        };
        addToast(msgs[action], true);
        await refresh({ silent: true });
      } else {
        const d = await res.json().catch(() => ({}));
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
    <main className="min-h-screen relative bg-gradient-to-br from-slate-50 via-indigo-50/60 to-violet-100/50 text-slate-800 overflow-x-hidden">
      {/* Ambient glow orbs */}
      <div className="pointer-events-none fixed -top-32 -left-32 w-96 h-96 rounded-full bg-indigo-300/25 blur-3xl" />
      <div className="pointer-events-none fixed -bottom-40 -right-24 w-[28rem] h-[28rem] rounded-full bg-violet-300/25 blur-3xl" />

      <Toast toasts={toasts} />
      {newTaskOpen && (
        <NewTaskModal
          onClose={() => setNewTaskOpen(false)}
          onCreated={() => refresh({ silent: true })}
          toast={addToast}
        />
      )}

      <div className="relative max-w-4xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-8 gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center text-xl shadow-lg shadow-indigo-500/30">📋</div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-slate-800">Task Tracker</h1>
              <p className="text-slate-400 text-xs">
                Updated {timeAgo(lastRefresh.toISOString())}
                {userEmail && <span className="hidden sm:inline"> · {userEmail}</span>}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => refresh()}
              disabled={refreshing}
              className="inline-flex items-center gap-2 bg-white/80 border border-slate-200 hover:bg-white text-slate-600 font-medium text-sm px-4 py-2.5 rounded-xl shadow-sm transition-colors disabled:opacity-60"
              title="Refresh tasks"
            >
              <IconRefresh spinning={refreshing} />
              {refreshing ? "Refreshing..." : "Refresh"}
            </button>
            <button
              onClick={() => setNewTaskOpen(true)}
              className="inline-flex items-center gap-2 bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 text-white font-semibold text-sm px-5 py-2.5 rounded-xl shadow-lg shadow-indigo-500/25 transition-all active:scale-[0.98]"
            >
              <IconPlus /> New Task
            </button>
            <button
              onClick={signOut}
              className="inline-flex items-center gap-2 bg-white/80 border border-slate-200 hover:bg-white text-slate-500 font-medium text-sm px-3.5 py-2.5 rounded-xl shadow-sm transition-colors"
              title="Sign out"
            >
              <IconLogout />
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </div>

        {/* Stats bar */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-6">
          {[
            { label: "Active",       count: counts.active,             color: "text-indigo-500",  ring: "from-indigo-400/20" },
            { label: "Needs Review", count: counts.pending_review,     color: "text-amber-500",   ring: "from-amber-400/20" },
            { label: "Revision",     count: counts.revision_requested, color: "text-orange-500",  ring: "from-orange-400/20" },
            { label: "Done",         count: counts.completed,          color: "text-emerald-500", ring: "from-emerald-400/20" },
            { label: "Escalated",    count: counts.escalated,          color: "text-rose-500",    ring: "from-rose-400/20" },
          ].map(s => (
            <div key={s.label} className={`bg-white/70 backdrop-blur-xl rounded-2xl p-4 border border-white/90 shadow-md shadow-indigo-100/50 text-center bg-gradient-to-b ${s.ring} to-transparent`}>
              <p className="text-slate-400 text-xs mb-1">{s.label}</p>
              <p className={`text-2xl font-bold ${s.color}`}>{s.count}</p>
            </div>
          ))}
        </div>

        {/* Filter tabs */}
        <div className="flex gap-1.5 mb-5 overflow-x-auto pb-1">
          {FILTERS.map(f => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`shrink-0 px-4 py-2 rounded-xl text-sm font-medium transition-all flex items-center gap-1.5 ${
                filter === f.key
                  ? "bg-slate-800 text-white shadow-md"
                  : "bg-white/60 text-slate-500 hover:text-slate-700 hover:bg-white border border-white/80"
              }`}
            >
              {f.label}
              {counts[f.key] > 0 && (
                <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                  filter === f.key ? "bg-white/20 text-white" : "bg-slate-100 text-slate-400"
                }`}>
                  {counts[f.key]}
                </span>
              )}
              {f.key === "pending_review" && counts.pending_review > 0 && (
                <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
              )}
            </button>
          ))}
        </div>

        {/* Task list */}
        <div className="space-y-3">
          {visible.length === 0 && (
            <div className="text-center text-slate-400 py-16 bg-white/50 backdrop-blur-xl rounded-2xl border border-white/80">
              {filter === "all" ? "No tasks yet. Create one above!" : `No ${filter.replace(/_/g, " ")} tasks.`}
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
