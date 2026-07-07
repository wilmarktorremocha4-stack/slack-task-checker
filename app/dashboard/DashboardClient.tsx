"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { createSupabaseBrowser } from "@/lib/supabase-browser";
import type { Task, TaskComment } from "@/lib/supabase";

type TaskWithComments = Task & { task_comments: TaskComment[] };
type SlackUser = { id: string; name: string };
type ToastType = { id: number; message: string; ok: boolean };
type TaskAction = "approve" | "cancel" | "revision" | "followup_now" | "reopen" | "message";

const STATUS = {
  active:             { label: "Active",        badge: "bg-indigo-500/20 text-indigo-300 border-indigo-500/30",  dot: "bg-indigo-400" },
  pending_review:     { label: "Needs Review",  badge: "bg-amber-500/20 text-amber-300 border-amber-500/30",     dot: "bg-amber-400" },
  revision_requested: { label: "Revision Sent", badge: "bg-orange-500/20 text-orange-300 border-orange-500/30",  dot: "bg-orange-400" },
  completed:          { label: "Done",          badge: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30", dot: "bg-emerald-400" },
  escalated:          { label: "Escalated",     badge: "bg-rose-500/20 text-rose-300 border-rose-500/30",        dot: "bg-rose-400" },
  cancelled:          { label: "Cancelled",     badge: "bg-white/[0.08] text-white/40 border-white/10",          dot: "bg-white/30" },
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
              ? "bg-emerald-950/90 border-emerald-500/40 text-emerald-300"
              : "bg-rose-950/90 border-rose-500/40 text-rose-300"
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
  return createPortal(
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-[#0d1b2e]/95 backdrop-blur-xl border border-white/10 rounded-2xl w-full max-w-sm shadow-2xl shadow-black/60 p-6 anim-pop">
        <h3 className="text-base font-semibold text-white/90 mb-2">{title}</h3>
        <p className="text-sm text-white/50 mb-6 leading-relaxed">{body}</p>
        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 bg-white/[0.06] border border-white/10 hover:bg-white/10 hover:shadow-md text-white/70 font-medium text-sm py-2.5 rounded-xl transition-all active:scale-[0.98]"
          >
            Keep as is
          </button>
          <button
            onClick={() => { onConfirm(); onClose(); }}
            className={`flex-1 font-semibold text-sm py-2.5 rounded-xl text-white transition-all active:scale-[0.98] shadow-lg ${
              danger
                ? "bg-rose-500/90 hover:bg-rose-500 hover:shadow-xl hover:shadow-rose-500/30 hover:-translate-y-0.5"
                : "bg-indigo-500/90 hover:bg-indigo-500 hover:shadow-xl hover:shadow-indigo-500/30 hover:-translate-y-0.5"
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
        <span className="text-xs text-white/30 italic px-3 py-1 bg-white/[0.04] border border-white/[0.06] rounded-full text-center">
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
          : "bg-white/10 text-white/70"
      }`}>
        {c.author_name.charAt(0).toUpperCase()}
      </div>
      <div className={`max-w-[75%] ${isBrandon ? "items-end" : "items-start"} flex flex-col`}>
        <span className="text-xs text-white/30 mb-1 px-1">
          {c.author_name} · {timeAgo(c.created_at)}
        </span>
        <div className={`px-3.5 py-2 rounded-2xl text-sm leading-relaxed ${
          isBrandon
            ? "bg-gradient-to-br from-indigo-500 to-violet-600 text-white rounded-tr-sm shadow-md shadow-indigo-500/20"
            : "bg-white/[0.07] border border-white/10 text-white/80 rounded-tl-sm"
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
  onAction: (taskId: string, action: TaskAction, content?: string) => Promise<void>;
}) {
  const [revisionText, setRevisionText] = useState("");
  const [messageText, setMessageText] = useState("");
  const [working, setWorking] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"cancel" | "followup_now" | "reopen" | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const cfg = STATUS[task.status] ?? STATUS.active;
  const isPendingReview = task.status === "pending_review";
  const isOpen = task.status === "active" || task.status === "revision_requested";

  useEffect(() => {
    if (expanded && threadRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }
  }, [expanded, task.task_comments]);

  async function handle(action: TaskAction) {
    if (action === "revision" && !revisionText.trim()) return;
    if (action === "message" && !messageText.trim()) return;
    setWorking(action);
    const content =
      action === "revision" ? revisionText : action === "message" ? messageText : undefined;
    await onAction(task.id, action, content);
    if (action === "revision") setRevisionText("");
    if (action === "message") setMessageText("");
    setWorking(null);
  }

  const sortedComments = [...(task.task_comments ?? [])].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );

  const followupsLeft = task.max_followups - task.followup_count;

  return (
    <div
      className={`rounded-2xl border transition-all duration-200 bg-white/[0.04] backdrop-blur-xl ${
        isPendingReview
          ? "border-amber-400/30 shadow-lg shadow-amber-500/10 ring-1 ring-amber-400/20"
          : "border-white/[0.07] shadow-md shadow-black/30 hover:shadow-lg hover:shadow-blue-500/10 hover:border-white/[0.12]"
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
      {confirm === "reopen" && (
        <ConfirmDialog
          title="Reopen this task?"
          body={`${task.assigned_to_name} will be notified in Slack that the task is active again, and the follow-up schedule will restart from the beginning.`}
          confirmLabel="Yes, reopen task"
          onConfirm={() => handle("reopen")}
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
        className="w-full text-left p-5 flex items-start gap-4 hover:bg-white/[0.03] rounded-2xl transition-colors"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5 flex-wrap">
            <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-0.5 rounded-full border ${cfg.badge}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot} ${isPendingReview ? "animate-pulse" : ""}`} />
              {cfg.label}
            </span>
            {isPendingReview && (
              <span className="text-xs font-medium text-amber-400">Awaiting your review</span>
            )}
            <span className="text-white/30 text-xs">{timeAgo(task.created_at)}</span>
          </div>
          <p className="font-medium text-white/90 leading-snug">{task.task_text}</p>
          <p className="text-sm text-white/40 mt-1">
            <span className="text-white/60 font-medium">{task.assigned_to_name}</span>
            <span className="mx-1 text-white/20">·</span>
            assigned by {task.assigned_by_name}
          </p>
        </div>

        <div className="text-right shrink-0 flex flex-col items-end gap-1">
          <span className="text-xs text-white/30">
            {task.followup_count}/{task.max_followups} follow-ups
          </span>
          {isOpen && task.next_followup_at && (
            <span className={`text-xs font-medium ${nextIn(task.next_followup_at) === "overdue" ? "text-rose-400" : "text-indigo-400"}`}>
              Next: {nextIn(task.next_followup_at)}
            </span>
          )}
          {task.status === "completed" && task.completed_at && (
            <span className="text-xs text-emerald-400">Completed {timeAgo(task.completed_at)}</span>
          )}
          {task.status === "escalated" && task.escalated_at && (
            <span className="text-xs text-rose-400">Escalated {timeAgo(task.escalated_at)}</span>
          )}
          <svg
            className={`w-4 h-4 text-white/20 mt-1 transition-transform ${expanded ? "rotate-180" : ""}`}
            viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </div>
      </button>

      {/* Expanded thread + actions */}
      {expanded && (
        <div className="border-t border-white/[0.07] px-5 pb-5 pt-4 anim-expand">

          {/* Activity / History section */}
          <div className="mb-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-[11px] font-semibold text-white/30 uppercase tracking-widest">Activity</span>
              <div className="flex-1 h-px bg-white/[0.07]" />
            </div>
            {sortedComments.length > 0 ? (
              <div
                ref={threadRef}
                className="flex flex-col gap-3 max-h-72 overflow-y-auto pr-1"
              >
                {sortedComments.map(c => (
                  <CommentBubble key={c.id} c={c} />
                ))}
              </div>
            ) : (
              <p className="text-sm text-white/30 italic text-center py-3">
                No activity yet — messages and events will appear here.
              </p>
            )}
          </div>

          {/* Actions for pending_review */}
          {isPendingReview && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm text-amber-300 font-medium bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-2.5">
                <span>👀</span>
                <span>{task.assigned_to_name} says this is done. Approve it, or describe what needs revising.</span>
              </div>
              <textarea
                value={revisionText}
                onChange={e => setRevisionText(e.target.value)}
                placeholder="Describe what needs to be changed or fixed..."
                className="w-full bg-white/[0.06] border border-white/10 rounded-xl px-4 py-3 text-sm text-white/80 placeholder-white/25 focus:outline-none focus:ring-2 focus:ring-orange-400/30 focus:border-orange-400/40 resize-none"
                rows={3}
              />
              <div className="flex gap-3">
                <button
                  disabled={!!working}
                  onClick={() => handle("approve")}
                  className="flex-1 inline-flex items-center justify-center gap-2 bg-emerald-500/90 hover:bg-emerald-500 hover:shadow-xl hover:shadow-emerald-500/25 hover:-translate-y-0.5 disabled:opacity-50 disabled:hover:translate-y-0 text-white font-semibold text-sm py-2.5 rounded-xl shadow-lg shadow-emerald-500/20 transition-all active:scale-[0.98]"
                >
                  <IconCheck /> {working === "approve" ? "Approving..." : "Approve & Close"}
                </button>
                <button
                  disabled={!!working || !revisionText.trim()}
                  onClick={() => handle("revision")}
                  className="flex-1 inline-flex items-center justify-center gap-2 bg-orange-500/90 hover:bg-orange-500 hover:shadow-xl hover:shadow-orange-500/25 hover:-translate-y-0.5 disabled:opacity-50 disabled:hover:translate-y-0 text-white font-semibold text-sm py-2.5 rounded-xl shadow-lg shadow-orange-500/20 transition-all active:scale-[0.98]"
                >
                  <IconEdit /> {working === "revision" ? "Sending..." : "Request Revision"}
                </button>
              </div>
              <button
                disabled={!!working}
                onClick={() => setConfirm("cancel")}
                className="w-full inline-flex items-center justify-center gap-2 bg-white/[0.05] border border-rose-500/30 hover:bg-rose-500/10 hover:border-rose-500/50 hover:shadow-md hover:-translate-y-0.5 text-rose-400 font-medium text-sm py-2.5 rounded-xl transition-all disabled:opacity-50 disabled:hover:translate-y-0 active:scale-[0.98]"
              >
                <IconTrash /> Cancel Task
              </button>
            </div>
          )}

          {/* Actions for open tasks (active / revision_requested) */}
          {isOpen && (
            <div className="space-y-3">
              <p className="text-xs text-white/30 text-center">
                Waiting for {task.assigned_to_name} to respond. Follow-ups are running automatically.
              </p>
              <div className="flex gap-3">
                <button
                  disabled={!!working}
                  onClick={() => setConfirm("followup_now")}
                  className="flex-1 inline-flex items-center justify-center gap-2 bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 hover:shadow-xl hover:shadow-indigo-500/30 hover:-translate-y-0.5 disabled:opacity-50 disabled:hover:translate-y-0 text-white font-semibold text-sm py-2.5 rounded-xl shadow-lg shadow-indigo-500/20 transition-all active:scale-[0.98]"
                >
                  <IconBolt /> {working === "followup_now" ? "Sending..." : "Send Follow-up Now"}
                </button>
                <button
                  disabled={!!working}
                  onClick={() => setConfirm("cancel")}
                  className="flex-1 inline-flex items-center justify-center gap-2 bg-white/[0.05] border border-rose-500/30 hover:bg-rose-500/10 hover:border-rose-500/50 hover:shadow-md hover:-translate-y-0.5 text-rose-400 font-medium text-sm py-2.5 rounded-xl transition-all disabled:opacity-50 disabled:hover:translate-y-0 active:scale-[0.98]"
                >
                  <IconTrash /> {working === "cancel" ? "Cancelling..." : "Cancel Task"}
                </button>
              </div>
            </div>
          )}

          {/* Closed statuses: allow reopening */}
          {(task.status === "completed" || task.status === "escalated" || task.status === "cancelled") && (
            <div className="space-y-3">
              <p className="text-xs text-white/30 text-center italic">
                This task is closed. You can still message the thread below, or reopen it.
              </p>
              <button
                disabled={!!working}
                onClick={() => setConfirm("reopen")}
                className="w-full inline-flex items-center justify-center gap-2 bg-white/[0.05] border border-indigo-500/30 hover:bg-indigo-500/10 hover:border-indigo-500/50 hover:shadow-md hover:-translate-y-0.5 text-indigo-400 font-medium text-sm py-2.5 rounded-xl transition-all disabled:opacity-50 disabled:hover:translate-y-0 active:scale-[0.98]"
              >
                <IconRefresh /> {working === "reopen" ? "Reopening..." : "Reopen Task"}
              </button>
            </div>
          )}

          {/* Message composer */}
          <div className="mt-4 pt-4 border-t border-white/[0.07]">
            <div className="flex gap-2">
              <input
                type="text"
                value={messageText}
                onChange={e => setMessageText(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter" && messageText.trim() && !working) handle("message");
                }}
                placeholder={`Message ${task.assigned_to_name} in the Slack thread...`}
                className="flex-1 bg-white/[0.06] border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white/80 placeholder-white/25 focus:outline-none focus:ring-2 focus:ring-indigo-400/30 focus:border-indigo-400/40"
              />
              <button
                disabled={!!working || !messageText.trim()}
                onClick={() => handle("message")}
                className="inline-flex items-center gap-2 bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 hover:shadow-lg hover:shadow-indigo-500/30 hover:-translate-y-0.5 disabled:opacity-50 disabled:hover:translate-y-0 text-white font-semibold text-sm px-4 py-2.5 rounded-xl shadow-md shadow-indigo-500/20 transition-all active:scale-[0.98]"
                title="Send message to Slack thread"
              >
                {working === "message" ? (
                  "Sending..."
                ) : (
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m22 2-7 20-4-9-9-4Z" />
                    <path d="M22 2 11 13" />
                  </svg>
                )}
              </button>
            </div>
            <p className="text-[11px] text-white/25 mt-1.5 px-1">
              Sends to the Slack thread with a real @mention. Doesn&apos;t change status or follow-ups.
            </p>
          </div>
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
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 flex items-center justify-center p-4">
      <div className="bg-[#0d1b2e]/95 backdrop-blur-xl border border-white/10 rounded-3xl w-full max-w-lg shadow-2xl shadow-black/60 anim-pop">
        <div className="flex items-center justify-between p-6 border-b border-white/[0.07]">
          <h2 className="text-lg font-semibold text-white/90">Assign New Task</h2>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-white/[0.07] hover:bg-white/[0.12] hover:text-white hover:rotate-90 text-white/50 flex items-center justify-center transition-all duration-200"
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
            <label className="block text-sm font-medium text-white/50 mb-2">Assign to</label>
            {loadingUsers ? (
              <div className="text-sm text-white/30 py-2">Loading team members...</div>
            ) : selectedUser ? (
              <div className="flex items-center justify-between bg-indigo-500/10 border border-indigo-500/30 rounded-xl px-4 py-3 anim-pop">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 text-white flex items-center justify-center text-sm font-bold">
                    {selectedUser.name.charAt(0).toUpperCase()}
                  </div>
                  <span className="text-sm font-semibold text-white/80">{selectedUser.name}</span>
                </div>
                <button
                  type="button"
                  onClick={() => { setAssigneeId(""); setUserSearch(""); }}
                  className="text-xs font-medium text-indigo-400 hover:text-indigo-300 bg-white/[0.07] border border-white/10 hover:bg-white/10 px-3 py-1.5 rounded-lg transition-all active:scale-[0.97]"
                >
                  Change
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                <input
                  type="text"
                  placeholder="Search team members..."
                  value={userSearch}
                  onChange={e => setUserSearch(e.target.value)}
                  className="w-full bg-white/[0.06] border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white/80 placeholder-white/25 focus:outline-none focus:ring-2 focus:ring-indigo-400/30 focus:border-indigo-400/40"
                />
                <div className="max-h-40 overflow-y-auto bg-white/[0.04] border border-white/[0.07] rounded-xl divide-y divide-white/[0.05]">
                  {filteredUsers.length === 0 && (
                    <p className="text-sm text-white/30 p-3 text-center">No members found</p>
                  )}
                  {filteredUsers.map(u => (
                    <button
                      key={u.id}
                      type="button"
                      onClick={() => { setAssigneeId(u.id); setUserSearch(""); }}
                      className="w-full text-left px-4 py-2.5 text-sm text-white/60 hover:bg-indigo-500/10 hover:text-white/90 transition-colors"
                    >
                      {u.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Task text */}
          <div>
            <label className="block text-sm font-medium text-white/50 mb-2">Task description</label>
            <textarea
              required
              value={taskText}
              onChange={e => setTaskText(e.target.value)}
              placeholder="e.g. Prepare the supplier outreach plan by Friday"
              className="w-full bg-white/[0.06] border border-white/10 rounded-xl px-4 py-3 text-sm text-white/80 placeholder-white/25 focus:outline-none focus:ring-2 focus:ring-indigo-400/30 focus:border-indigo-400/40 resize-none"
              rows={4}
            />
          </div>

          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 bg-white/[0.06] border border-white/10 hover:bg-white/[0.10] hover:shadow-md text-white/60 font-medium text-sm py-3 rounded-xl transition-all active:scale-[0.98]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!assigneeId || !taskText.trim() || submitting}
              className="flex-1 bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 hover:shadow-xl hover:shadow-indigo-500/30 hover:-translate-y-0.5 disabled:opacity-50 disabled:hover:translate-y-0 text-white font-semibold text-sm py-3 rounded-xl shadow-lg shadow-indigo-500/20 transition-all active:scale-[0.98]"
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

  async function handleAction(taskId: string, action: TaskAction, content?: string) {
    try {
      let res: Response;
      if (action === "revision") {
        res = await fetch(`/api/tasks/${taskId}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content }),
        });
      } else if (action === "message") {
        res = await fetch(`/api/tasks/${taskId}/message`, {
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
        const msgs: Record<TaskAction, string> = {
          approve: "Task approved and closed",
          cancel: "Task cancelled — assignee notified in Slack",
          revision: "Revision sent to the Slack thread",
          followup_now: "Follow-up sent to Slack",
          reopen: "Task reopened — assignee notified in Slack",
          message: "Message sent to the Slack thread",
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
    <main className="min-h-screen relative bg-[#040b18] text-white overflow-x-hidden">
      {/* Deep space glow orbs */}
      <div className="pointer-events-none fixed -top-48 -left-48 w-[40rem] h-[40rem] rounded-full bg-blue-600/15 blur-[120px]" />
      <div className="pointer-events-none fixed -bottom-48 -right-32 w-[36rem] h-[36rem] rounded-full bg-indigo-700/15 blur-[120px]" />
      <div className="pointer-events-none fixed top-1/3 left-1/2 -translate-x-1/2 w-96 h-96 rounded-full bg-violet-600/8 blur-[100px]" />

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
              <h1 className="text-2xl font-bold tracking-tight text-white/90">Task Tracker</h1>
              <p className="text-white/30 text-xs">
                Updated {timeAgo(lastRefresh.toISOString())}
                {userEmail && <span className="hidden sm:inline"> · {userEmail}</span>}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => refresh()}
              disabled={refreshing}
              className="inline-flex items-center gap-2 bg-white/[0.07] border border-white/10 hover:bg-white/[0.12] hover:shadow-md hover:-translate-y-0.5 text-white/60 font-medium text-sm px-4 py-2.5 rounded-xl transition-all disabled:opacity-60 disabled:hover:translate-y-0 active:scale-[0.98]"
              title="Refresh tasks"
            >
              <IconRefresh spinning={refreshing} />
              {refreshing ? "Refreshing..." : "Refresh"}
            </button>
            <button
              onClick={() => setNewTaskOpen(true)}
              className="inline-flex items-center gap-2 bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 hover:shadow-xl hover:shadow-indigo-500/30 hover:-translate-y-0.5 text-white font-semibold text-sm px-5 py-2.5 rounded-xl shadow-lg shadow-indigo-500/20 transition-all active:scale-[0.98]"
            >
              <IconPlus /> New Task
            </button>
            <button
              onClick={signOut}
              className="inline-flex items-center gap-2 bg-white/[0.07] border border-white/10 hover:bg-white/[0.12] hover:shadow-md hover:-translate-y-0.5 hover:text-rose-400 text-white/50 font-medium text-sm px-3.5 py-2.5 rounded-xl transition-all active:scale-[0.98]"
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
            { label: "Active",       count: counts.active,             color: "text-indigo-400",  glow: "bg-indigo-500/10" },
            { label: "Needs Review", count: counts.pending_review,     color: "text-amber-400",   glow: "bg-amber-500/10" },
            { label: "Revision",     count: counts.revision_requested, color: "text-orange-400",  glow: "bg-orange-500/10" },
            { label: "Done",         count: counts.completed,          color: "text-emerald-400", glow: "bg-emerald-500/10" },
            { label: "Escalated",    count: counts.escalated,          color: "text-rose-400",    glow: "bg-rose-500/10" },
          ].map((s, i) => (
            <div key={s.label} className={`${s.glow} backdrop-blur-xl rounded-2xl p-4 border border-white/[0.07] shadow-md shadow-black/40 text-center anim-rise hover:-translate-y-0.5 hover:shadow-lg hover:border-white/[0.12] transition-all duration-200`} style={{ animationDelay: `${i * 60}ms` }}>
              <p className="text-white/30 text-xs mb-1">{s.label}</p>
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
                  ? "bg-white/[0.12] text-white shadow-md border border-white/[0.15]"
                  : "bg-white/[0.04] text-white/40 hover:text-white/70 hover:bg-white/[0.08] hover:shadow-md hover:-translate-y-0.5 border border-white/[0.06]"
              }`}
            >
              {f.label}
              {counts[f.key] > 0 && (
                <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                  filter === f.key ? "bg-white/20 text-white" : "bg-white/[0.08] text-white/40"
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
            <div className="text-center text-white/30 py-16 bg-white/[0.03] backdrop-blur-xl rounded-2xl border border-white/[0.06]">
              {filter === "all" ? "No tasks yet. Create one above!" : `No ${filter.replace(/_/g, " ")} tasks.`}
            </div>
          )}
          {visible.map((task, i) => (
            <div key={task.id} className="anim-rise" style={{ animationDelay: `${Math.min(i, 8) * 50}ms` }}>
              <TaskCard
                task={task}
                expanded={expandedId === task.id}
                onToggle={() => setExpandedId(expandedId === task.id ? null : task.id)}
                onAction={handleAction}
              />
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
