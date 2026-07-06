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
type SortBy = "status" | "date_desc" | "date_asc";

const STATUS = {
  active:             { label: "Active",        badge: "bg-blue-500/20 text-blue-300 border-blue-500/30",       dot: "bg-blue-400" },
  pending_review:     { label: "Needs Review",  badge: "bg-amber-500/20 text-amber-300 border-amber-500/30",    dot: "bg-amber-400" },
  revision_requested: { label: "Revision Sent", badge: "bg-orange-500/20 text-orange-300 border-orange-500/30", dot: "bg-orange-400" },
  completed:          { label: "Done",          badge: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30", dot: "bg-emerald-400" },
  escalated:          { label: "Escalated",     badge: "bg-rose-500/20 text-rose-300 border-rose-500/30",       dot: "bg-rose-400" },
  cancelled:          { label: "Cancelled",     badge: "bg-slate-700/60 text-slate-400 border-slate-600/30",    dot: "bg-slate-500" },
} as const;

const FILTERS = [
  { key: "all",                label: "All" },
  { key: "by_employee",        label: "By Employee" },
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

function formatDate(d: string) {
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function nextIn(d: string | null) {
  if (!d) return null;
  const diff = new Date(d).getTime() - Date.now();
  if (diff < 0) return "overdue";
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  return h > 0 ? `in ${h}h ${m}m` : `in ${m}m`;
}

function sortByStatus(tasks: TaskWithComments[]) {
  const order = ["pending_review", "revision_requested", "active", "escalated", "completed", "cancelled"];
  return [...tasks].sort((a, b) => {
    const ai = order.indexOf(a.status);
    const bi = order.indexOf(b.status);
    if (ai !== bi) return ai - bi;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
}

function applySort(tasks: TaskWithComments[], sort: SortBy) {
  if (sort === "date_desc") return [...tasks].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  if (sort === "date_asc")  return [...tasks].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  return sortByStatus(tasks);
}

function groupByEmployee(tasks: TaskWithComments[]) {
  const map: Record<string, TaskWithComments[]> = {};
  for (const t of tasks) {
    const names = t.assignee_names?.length ? t.assignee_names : [t.assigned_to_name];
    for (const name of names) {
      if (!map[name]) map[name] = [];
      if (!map[name].includes(t)) map[name].push(t);
    }
  }
  return map;
}

// ── Icons ───────────────────────────────────────────────────────────────────

function IconRefresh({ spinning }: { spinning?: boolean }) {
  return (
    <svg className={`w-4 h-4 ${spinning ? "anim-spin-slow" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" />
    </svg>
  );
}
function IconBolt() {
  return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" /></svg>;
}
function IconCheck() {
  return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>;
}
function IconEdit() {
  return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /></svg>;
}
function IconTrash() {
  return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></svg>;
}
function IconPlus() {
  return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>;
}
function IconLogout() {
  return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></svg>;
}
function IconSend() {
  return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></svg>;
}
function IconUser() {
  return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>;
}

function AppLogo({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const dim = size === "sm" ? "w-8 h-8" : size === "lg" ? "w-16 h-16" : "w-11 h-11";
  const icon = size === "sm" ? "w-4 h-4" : size === "lg" ? "w-8 h-8" : "w-5 h-5";
  return (
    <div className={`${dim} rounded-2xl flex items-center justify-center shadow-lg shadow-blue-500/30 shrink-0`}
      style={{ background: "linear-gradient(135deg, #1d4ed8 0%, #3b82f6 50%, #60a5fa 100%)" }}>
      <svg className={`${icon} text-white`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 11l3 3L22 4" />
        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
      </svg>
    </div>
  );
}
function IconSpinner() {
  return (
    <svg className="w-4 h-4 anim-spin-slow" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

// ── Toast ───────────────────────────────────────────────────────────────────

function Toast({ toasts }: { toasts: ToastType[] }) {
  if (!toasts.length) return null;
  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map(t => (
        <div key={t.id} className={`px-4 py-3 rounded-xl text-sm font-medium shadow-xl border backdrop-blur-xl ${
          t.ok ? "bg-emerald-950/90 border-emerald-500/30 text-emerald-300" : "bg-rose-950/90 border-rose-500/30 text-rose-300"
        }`}>
          {t.ok ? "✓" : "✗"} {t.message}
        </div>
      ))}
    </div>
  );
}

// ── Confirm dialog ──────────────────────────────────────────────────────────

function ConfirmDialog({ title, body, confirmLabel, danger, onConfirm, onClose }: {
  title: string; body: string; confirmLabel: string; danger?: boolean; onConfirm: () => void; onClose: () => void;
}) {
  return createPortal(
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-slate-900/95 backdrop-blur-xl border border-slate-700/60 rounded-2xl w-full max-w-sm shadow-2xl shadow-black/50 p-6 anim-pop">
        <h3 className="text-base font-semibold text-slate-100 mb-2">{title}</h3>
        <p className="text-sm text-slate-400 mb-6 leading-relaxed">{body}</p>
        <div className="flex gap-3">
          <button onClick={onClose} className="flex-1 bg-slate-800 border border-slate-700 hover:bg-slate-700 text-slate-300 font-medium text-sm py-2.5 rounded-xl transition-all active:scale-[0.98]">
            Keep as is
          </button>
          <button
            onClick={() => { onConfirm(); onClose(); }}
            className={`flex-1 font-semibold text-sm py-2.5 rounded-xl text-white transition-all active:scale-[0.98] shadow-lg ${
              danger ? "bg-rose-600 hover:bg-rose-700 shadow-rose-500/20" : "bg-blue-600 hover:bg-blue-700 shadow-blue-500/20"
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
        <span className="text-xs text-slate-500 italic px-3 py-1 bg-slate-800/60 rounded-full text-center border border-slate-700/30">
          {c.content} · {timeAgo(c.created_at)}
        </span>
      </div>
    );
  }
  const isBrandon = c.author_type === "brandon";
  return (
    <div className={`flex gap-2 ${isBrandon ? "flex-row-reverse" : "flex-row"}`}>
      <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
        isBrandon ? "bg-gradient-to-br from-blue-500 to-blue-700 text-white" : "bg-slate-700 text-slate-300"
      }`}>
        {c.author_name.charAt(0).toUpperCase()}
      </div>
      <div className={`max-w-[75%] ${isBrandon ? "items-end" : "items-start"} flex flex-col`}>
        <span className="text-xs text-slate-500 mb-1 px-1">{c.author_name} · {timeAgo(c.created_at)}</span>
        <div className={`px-3.5 py-2 rounded-2xl text-sm leading-relaxed ${
          isBrandon
            ? "bg-gradient-to-br from-blue-600 to-blue-800 text-white rounded-tr-sm shadow-lg shadow-blue-500/20"
            : "bg-slate-800 border border-slate-700/60 text-slate-200 rounded-tl-sm"
        }`}>
          {c.content}
        </div>
      </div>
    </div>
  );
}

// ── Task Card ───────────────────────────────────────────────────────────────

function TaskCard({ task, expanded, onToggle, onAction }: {
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
  const isActive = task.status === "active";
  const isClosed = task.status === "completed" || task.status === "escalated" || task.status === "cancelled";

  useEffect(() => {
    if (expanded && threadRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }
  }, [expanded, task.task_comments]);

  async function handle(action: TaskAction) {
    if (action === "revision" && !revisionText.trim()) return;
    if (action === "message" && !messageText.trim()) return;
    setWorking(action);
    const content = action === "revision" ? revisionText : action === "message" ? messageText : undefined;
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
    <div className={`rounded-2xl border transition-all duration-200 bg-slate-900/50 backdrop-blur-xl ${
      isPendingReview
        ? "border-amber-500/40 shadow-lg shadow-amber-500/10 ring-1 ring-amber-500/20"
        : "border-slate-700/40 hover:border-slate-600/60 hover:shadow-lg hover:shadow-blue-900/20"
    }`}>
      {confirm === "cancel" && (
        <ConfirmDialog title="Cancel this task?" body={`${task.assigned_to_name} will be notified in Slack that the task is cancelled, and all follow-ups will stop.`} confirmLabel="Yes, cancel task" danger onConfirm={() => handle("cancel")} onClose={() => setConfirm(null)} />
      )}
      {confirm === "reopen" && (
        <ConfirmDialog title="Reopen this task?" body={`${task.assigned_to_name} will be notified in Slack that the task is active again, and the follow-up schedule will restart.`} confirmLabel="Yes, reopen task" onConfirm={() => handle("reopen")} onClose={() => setConfirm(null)} />
      )}
      {confirm === "followup_now" && (
        <ConfirmDialog
          title="Send a follow-up right now?"
          body={followupsLeft > 0 ? `This sends follow-up #${task.followup_count + 1} of ${task.max_followups} to ${task.assigned_to_name} immediately.` : `All ${task.max_followups} follow-ups are used. Sending now will ESCALATE the task and DM Brandon.`}
          confirmLabel={followupsLeft > 0 ? "Send follow-up" : "Escalate now"}
          danger={followupsLeft <= 0}
          onConfirm={() => handle("followup_now")}
          onClose={() => setConfirm(null)}
        />
      )}

      {/* Card header */}
      <button onClick={onToggle} className="w-full text-left p-5 flex items-start gap-4 hover:bg-white/[0.02] rounded-2xl transition-colors">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5 flex-wrap">
            <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-0.5 rounded-full border ${cfg.badge}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot} ${isPendingReview ? "animate-pulse" : ""}`} />
              {cfg.label}
            </span>
            {isPendingReview && <span className="text-xs font-medium text-amber-400">Awaiting your review</span>}
          </div>
          <p className="font-medium text-slate-100 leading-snug">{task.task_text}</p>
          <p className="text-sm text-slate-500 mt-1">
            <span className="text-slate-300 font-medium">
              {(task.assignee_names?.length ? task.assignee_names : [task.assigned_to_name]).join(", ")}
            </span>
            <span className="mx-1 text-slate-600">·</span>
            assigned by {task.assigned_by_name}
          </p>
          <p className="text-xs text-slate-600 mt-0.5">{formatDate(task.created_at)} · {timeAgo(task.created_at)}</p>
        </div>

        <div className="text-right shrink-0 flex flex-col items-end gap-1">
          <span className="text-xs text-slate-500">{task.followup_count}/{task.max_followups} follow-ups</span>
          {isOpen && task.next_followup_at && (
            <span className={`text-xs font-medium ${nextIn(task.next_followup_at) === "overdue" ? "text-rose-400" : "text-blue-400"}`}>
              Next: {nextIn(task.next_followup_at)}
            </span>
          )}
          {task.status === "completed" && task.completed_at && (
            <span className="text-xs text-emerald-400">Completed {timeAgo(task.completed_at)}</span>
          )}
          {task.status === "escalated" && task.escalated_at && (
            <span className="text-xs text-rose-400">Escalated {timeAgo(task.escalated_at)}</span>
          )}
          <svg className={`w-4 h-4 text-slate-600 mt-1 transition-transform ${expanded ? "rotate-180" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </div>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-slate-700/40 px-5 pb-5 pt-4 anim-expand">
          {/* Thread history */}
          <div className="mb-4">
            <p className="text-xs text-slate-600 font-medium uppercase tracking-wide mb-3">Thread Activity</p>
            {sortedComments.length > 0 ? (
              <div ref={threadRef} className="flex flex-col gap-3 max-h-72 overflow-y-auto pr-1">
                {sortedComments.map(c => <CommentBubble key={c.id} c={c} />)}
              </div>
            ) : (
              <p className="text-sm text-slate-600 italic text-center py-4 bg-slate-800/30 rounded-xl border border-slate-700/30">
                No thread activity yet — Slack replies and actions will appear here.
              </p>
            )}
          </div>

          {/* pending_review actions */}
          {isPendingReview && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm text-amber-400 font-medium bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-2.5">
                <span>👀</span>
                <span>{task.assigned_to_name} says this is done. Approve it, or describe what needs revising.</span>
              </div>
              <textarea
                value={revisionText}
                onChange={e => setRevisionText(e.target.value)}
                placeholder="Describe what needs to be changed or fixed..."
                className="w-full bg-slate-800/60 border border-slate-700/60 rounded-xl px-4 py-3 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500/40 resize-none"
                rows={3}
              />
              <div className="flex gap-3">
                <button disabled={!!working} onClick={() => handle("approve")} className="flex-1 inline-flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-700 hover:shadow-xl hover:shadow-emerald-500/20 hover:-translate-y-0.5 disabled:opacity-50 text-white font-semibold text-sm py-2.5 rounded-xl shadow-lg shadow-emerald-500/15 transition-all active:scale-[0.98]">
                  <IconCheck /> {working === "approve" ? "Approving..." : "Approve & Close"}
                </button>
                <button disabled={!!working || !revisionText.trim()} onClick={() => handle("revision")} className="flex-1 inline-flex items-center justify-center gap-2 bg-orange-600 hover:bg-orange-700 hover:shadow-xl hover:shadow-orange-500/20 hover:-translate-y-0.5 disabled:opacity-50 text-white font-semibold text-sm py-2.5 rounded-xl shadow-lg shadow-orange-500/15 transition-all active:scale-[0.98]">
                  <IconEdit /> {working === "revision" ? "Sending..." : "Request Revision"}
                </button>
              </div>
              <button disabled={!!working} onClick={() => setConfirm("cancel")} className="w-full inline-flex items-center justify-center gap-2 bg-transparent border border-rose-500/30 hover:bg-rose-500/10 hover:border-rose-500/50 text-rose-400 font-medium text-sm py-2.5 rounded-xl transition-all disabled:opacity-50 active:scale-[0.98]">
                <IconTrash /> Cancel Task
              </button>
            </div>
          )}

          {/* Open task actions (active or revision_requested) */}
          {isOpen && (
            <div className="space-y-3">
              <div className="flex gap-3">
                <button disabled={!!working} onClick={() => setConfirm("followup_now")} className="flex-1 inline-flex items-center justify-center gap-2 bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 hover:shadow-xl hover:shadow-blue-500/25 hover:-translate-y-0.5 disabled:opacity-50 text-white font-semibold text-sm py-2.5 rounded-xl shadow-lg shadow-blue-500/20 transition-all active:scale-[0.98]">
                  <IconBolt /> {working === "followup_now" ? "Sending..." : "Send Follow-up Now"}
                </button>
                <button disabled={!!working} onClick={() => setConfirm("cancel")} className="flex-1 inline-flex items-center justify-center gap-2 bg-transparent border border-rose-500/30 hover:bg-rose-500/10 hover:border-rose-500/50 text-rose-400 font-medium text-sm py-2.5 rounded-xl transition-all disabled:opacity-50 active:scale-[0.98]">
                  <IconTrash /> {working === "cancel" ? "Cancelling..." : "Cancel Task"}
                </button>
              </div>

              {/* Message box — only for active, not revision_requested */}
              {isActive && (
                <div className="pt-3 border-t border-slate-700/40">
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={messageText}
                      onChange={e => setMessageText(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter" && messageText.trim() && !working) handle("message"); }}
                      placeholder={`Message ${(task.assignee_names?.length ? task.assignee_names : [task.assigned_to_name]).join(", ")} in the Slack thread...`}
                      className="flex-1 bg-slate-800/60 border border-slate-700/60 rounded-xl px-4 py-2.5 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500/40"
                    />
                    <button
                      disabled={!!working || !messageText.trim()}
                      onClick={() => handle("message")}
                      className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 hover:shadow-lg hover:shadow-blue-500/25 hover:-translate-y-0.5 disabled:opacity-40 text-white font-semibold text-sm px-4 py-2.5 rounded-xl shadow-md shadow-blue-500/15 transition-all active:scale-[0.98]"
                      title="Send to Slack thread"
                    >
                      {working === "message" ? <IconSpinner /> : <IconSend />}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Closed task actions */}
          {isClosed && (
            <button disabled={!!working} onClick={() => setConfirm("reopen")} className="w-full inline-flex items-center justify-center gap-2 bg-transparent border border-blue-500/30 hover:bg-blue-500/10 hover:border-blue-500/50 text-blue-400 font-medium text-sm py-2.5 rounded-xl transition-all disabled:opacity-50 active:scale-[0.98]">
              <IconRefresh spinning={working === "reopen"} /> {working === "reopen" ? "Reopening..." : "Reopen Task"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Employee view ───────────────────────────────────────────────────────────

function EmployeeView({ tasks, sortBy, expandedId, onToggle, onAction }: {
  tasks: TaskWithComments[];
  sortBy: SortBy;
  expandedId: string | null;
  onToggle: (id: string) => void;
  onAction: (taskId: string, action: TaskAction, content?: string) => Promise<void>;
}) {
  const grouped = groupByEmployee(tasks);
  const employees = Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b));

  if (employees.length === 0) {
    return (
      <div className="text-center text-slate-500 py-16 bg-slate-900/40 rounded-2xl border border-slate-700/30">
        No tasks assigned yet.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {employees.map(([name, empTasks]) => {
        const active = empTasks.filter(t => t.status === "active").length;
        const pending = empTasks.filter(t => t.status === "pending_review").length;
        const revision = empTasks.filter(t => t.status === "revision_requested").length;
        const done = empTasks.filter(t => t.status === "completed").length;
        const escalated = empTasks.filter(t => t.status === "escalated").length;
        return (
          <div key={name} className="rounded-2xl border border-slate-700/40 bg-slate-900/40 overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-700/40 flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center font-bold text-white text-sm shadow-lg shadow-blue-500/25">
                  {name.charAt(0).toUpperCase()}
                </div>
                <div>
                  <h3 className="font-semibold text-slate-100">{name}</h3>
                  <p className="text-xs text-slate-500">{empTasks.length} task{empTasks.length !== 1 ? "s" : ""} total</p>
                </div>
              </div>
              <div className="flex gap-3 text-xs flex-wrap">
                {active > 0    && <span className="px-2 py-1 rounded-full bg-blue-500/15 text-blue-300 border border-blue-500/20">{active} active</span>}
                {pending > 0   && <span className="px-2 py-1 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/20">{pending} review</span>}
                {revision > 0  && <span className="px-2 py-1 rounded-full bg-orange-500/15 text-orange-300 border border-orange-500/20">{revision} revision</span>}
                {done > 0      && <span className="px-2 py-1 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/20">{done} done</span>}
                {escalated > 0 && <span className="px-2 py-1 rounded-full bg-rose-500/15 text-rose-300 border border-rose-500/20">{escalated} escalated</span>}
              </div>
            </div>
            <div className="p-4 space-y-2">
              {applySort(empTasks, sortBy).map(task => (
                <TaskCard key={task.id} task={task} expanded={expandedId === task.id} onToggle={() => onToggle(task.id)} onAction={onAction} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── New Task Modal ──────────────────────────────────────────────────────────

const INPUT_CLS = "w-full bg-slate-800/60 border border-slate-700/60 rounded-xl px-4 py-2.5 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500/40";

function NewTaskModal({ onClose, onCreated, toast }: {
  onClose: () => void; onCreated: () => void; toast: (msg: string, ok: boolean) => void;
}) {
  const [users, setUsers] = useState<SlackUser[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [taskText, setTaskText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [userSearch, setUserSearch] = useState("");

  // Follow-up schedule: array of datetime-local strings
  const [followups, setFollowups] = useState<string[]>([""]);
  // Due date: "open" | "custom"
  const [dueDateMode, setDueDateMode] = useState<"open" | "custom">("open");
  const [dueDateVal, setDueDateVal] = useState("");

  useEffect(() => {
    fetch("/api/slack/users", { cache: "no-store" })
      .then(r => r.json()).then(d => setUsers(d.members ?? [])).catch(() => setUsers([])).finally(() => setLoadingUsers(false));
  }, []);

  const filteredUsers = userSearch
    ? users.filter(u => u.name.toLowerCase().includes(userSearch.toLowerCase()))
    : users;

  function toggleUser(u: SlackUser) {
    setSelectedIds(prev =>
      prev.includes(u.id) ? prev.filter(id => id !== u.id) : [...prev, u.id]
    );
  }

  function addFollowup() { setFollowups(prev => [...prev, ""]); }
  function removeFollowup(i: number) { setFollowups(prev => prev.filter((_, idx) => idx !== i)); }
  function setFollowupAt(i: number, val: string) { setFollowups(prev => { const n = [...prev]; n[i] = val; return n; }); }

  const dueMs = dueDateMode === "custom" && dueDateVal ? new Date(dueDateVal).getTime() : null;
  const followupWarnings = followups.map(f => {
    if (!f || !dueMs) return false;
    return new Date(f).getTime() > dueMs;
  });
  const hasWarning = followupWarnings.some(Boolean);
  const filledFollowups = followups.filter(f => f.trim());

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedIds.length || !taskText.trim() || hasWarning) return;
    if (filledFollowups.length === 0) return;

    const selectedUsers = selectedIds.map(id => users.find(u => u.id === id)!).filter(Boolean);
    const followupSchedule = filledFollowups.map(f => new Date(f).toISOString());
    const dueDate = dueDateMode === "custom" && dueDateVal ? new Date(dueDateVal).toISOString() : null;

    setSubmitting(true);
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          assigneeIds: selectedUsers.map(u => u.id),
          assigneeNames: selectedUsers.map(u => u.name),
          taskText,
          followupSchedule,
          dueDate,
        }),
      });
      if (res.ok) { toast("Task created and posted to Slack", true); onCreated(); onClose(); }
      else { const d = await res.json(); toast(d.error ?? "Failed to create task", false); }
    } catch { toast("Network error — please try again", false); }
    finally { setSubmitting(false); }
  }

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-40 flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-slate-900/95 backdrop-blur-xl border border-slate-700/60 rounded-3xl w-full max-w-lg shadow-2xl shadow-black/60 anim-pop my-4">
        <div className="flex items-center justify-between p-6 border-b border-slate-700/40">
          <h2 className="text-lg font-semibold text-slate-100">Assign New Task</h2>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-slate-800 hover:bg-slate-700 text-slate-400 flex items-center justify-center transition-all hover:rotate-90 duration-200">
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <form onSubmit={submit} className="p-6 space-y-5">
          {/* Assignees */}
          <div>
            <label className="block text-sm font-medium text-slate-400 mb-2">
              Assign to <span className="text-slate-600">(select one or more)</span>
            </label>
            {loadingUsers ? (
              <div className="text-sm text-slate-500 py-2">Loading team members...</div>
            ) : (
              <div className="space-y-2">
                <input
                  type="text"
                  placeholder="Search team members..."
                  value={userSearch}
                  onChange={e => setUserSearch(e.target.value)}
                  className={INPUT_CLS}
                />
                {/* Selected chips */}
                {selectedIds.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {selectedIds.map(id => {
                      const u = users.find(u => u.id === id);
                      if (!u) return null;
                      return (
                        <span key={id} className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-blue-500/15 border border-blue-500/30 text-blue-300 text-xs font-medium">
                          {u.name}
                          <button type="button" onClick={() => toggleUser(u)} className="text-blue-400 hover:text-white transition-colors">
                            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
                          </button>
                        </span>
                      );
                    })}
                  </div>
                )}
                <div className="max-h-36 overflow-y-auto bg-slate-800/60 border border-slate-700/60 rounded-xl divide-y divide-slate-700/40">
                  {filteredUsers.length === 0 && <p className="text-sm text-slate-500 p-3 text-center">No members found</p>}
                  {filteredUsers.map(u => {
                    const sel = selectedIds.includes(u.id);
                    return (
                      <button key={u.id} type="button" onClick={() => toggleUser(u)}
                        className={`w-full text-left px-4 py-2.5 text-sm flex items-center justify-between transition-colors ${sel ? "bg-blue-500/10 text-slate-200" : "text-slate-400 hover:bg-blue-500/10 hover:text-slate-200"}`}
                      >
                        {u.name}
                        {sel && <svg className="w-4 h-4 text-blue-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Task description */}
          <div>
            <label className="block text-sm font-medium text-slate-400 mb-2">Task description</label>
            <textarea
              required
              value={taskText}
              onChange={e => setTaskText(e.target.value)}
              placeholder="e.g. Prepare the supplier outreach plan by Friday"
              className="w-full bg-slate-800/60 border border-slate-700/60 rounded-xl px-4 py-3 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500/40 resize-none"
              rows={3}
            />
          </div>

          {/* Due date */}
          <div>
            <label className="block text-sm font-medium text-slate-400 mb-2">Due date</label>
            <div className="flex gap-2 mb-2">
              {(["open", "custom"] as const).map(m => (
                <button key={m} type="button" onClick={() => setDueDateMode(m)}
                  className={`px-4 py-1.5 rounded-lg text-sm font-medium border transition-all ${dueDateMode === m ? "bg-blue-600/20 border-blue-500/40 text-blue-300" : "bg-slate-800/60 border-slate-700/40 text-slate-500 hover:text-slate-300"}`}
                >
                  {m === "open" ? "Open (no due date)" : "Custom date"}
                </button>
              ))}
            </div>
            {dueDateMode === "custom" && (
              <input
                type="datetime-local"
                value={dueDateVal}
                onChange={e => setDueDateVal(e.target.value)}
                className={INPUT_CLS}
              />
            )}
          </div>

          {/* Follow-up schedule */}
          <div>
            <label className="block text-sm font-medium text-slate-400 mb-2">Follow-up schedule</label>
            <div className="space-y-2">
              {followups.map((f, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs text-slate-500">
                        {i === 0 ? "1st Follow-up" : i === 1 ? "2nd Follow-up" : i === 2 ? "3rd Follow-up" : `${i + 1}th Follow-up`}
                      </span>
                      {followupWarnings[i] && (
                        <span className="text-xs text-rose-400">⚠ After due date</span>
                      )}
                    </div>
                    <input
                      type="datetime-local"
                      value={f}
                      onChange={e => setFollowupAt(i, e.target.value)}
                      className={`${INPUT_CLS} ${followupWarnings[i] ? "border-rose-500/50 focus:ring-rose-500/30" : ""}`}
                    />
                  </div>
                  {followups.length > 1 && (
                    <button type="button" onClick={() => removeFollowup(i)}
                      className="mt-5 w-8 h-8 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-400 hover:bg-rose-500/20 flex items-center justify-center transition-all shrink-0"
                    >
                      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
                    </button>
                  )}
                </div>
              ))}
              <button type="button" onClick={addFollowup}
                className="inline-flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 bg-blue-500/10 border border-blue-500/20 hover:border-blue-500/40 px-3 py-1.5 rounded-lg transition-all"
              >
                <IconPlus /> Add follow-up
              </button>
            </div>
          </div>

          {/* Actions */}
          <div className="flex gap-3 pt-1">
            <button type="button" onClick={onClose} className="flex-1 bg-slate-800 border border-slate-700 hover:bg-slate-700 text-slate-300 font-medium text-sm py-3 rounded-xl transition-all active:scale-[0.98]">
              Cancel
            </button>
            <button
              type="submit"
              disabled={!selectedIds.length || !taskText.trim() || filledFollowups.length === 0 || hasWarning || submitting}
              className="flex-1 bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 hover:shadow-xl hover:shadow-blue-500/25 hover:-translate-y-0.5 disabled:opacity-50 text-white font-semibold text-sm py-3 rounded-xl shadow-lg shadow-blue-500/20 transition-all active:scale-[0.98]"
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

export default function DashboardClient({ initialTasks, userEmail }: {
  initialTasks: TaskWithComments[];
  userEmail?: string | null;
}) {
  const router = useRouter();
  const [tasks, setTasks] = useState<TaskWithComments[]>(sortByStatus(initialTasks));
  const [filter, setFilter] = useState("all");
  const [sortBy, setSortBy] = useState<SortBy>("status");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(new Date());
  const [refreshing, setRefreshing] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
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
      if (!res.ok) { if (!opts?.silent) addToast("Could not refresh — please try again", false); return; }
      const { tasks: fresh } = await res.json();
      setTasks(sortByStatus(fresh));
      setLastRefresh(new Date());
    } catch { if (!opts?.silent) addToast("Network error while refreshing", false); }
    finally { setRefreshing(false); }
  }, [addToast]);

  useEffect(() => {
    const timer = setInterval(() => refresh({ silent: true }), 30_000);
    return () => clearInterval(timer);
  }, [refresh]);

  async function signOut() {
    setSigningOut(true);
    try {
      const supabase = createSupabaseBrowser();
      await supabase.auth.signOut();
      router.push("/login");
      router.refresh();
    } catch {
      addToast("Sign out failed — please try again", false);
      setSigningOut(false);
    }
  }

  async function handleAction(taskId: string, action: TaskAction, content?: string) {
    try {
      let res: Response;
      if (action === "revision") {
        res = await fetch(`/api/tasks/${taskId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content }) });
      } else if (action === "message") {
        res = await fetch(`/api/tasks/${taskId}/message`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content }) });
      } else {
        res = await fetch(`/api/tasks/${taskId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });
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
    } catch { addToast("Network error — please try again", false); }
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

  const filteredTasks = filter === "all" || filter === "by_employee" ? tasks : tasks.filter(t => t.status === filter);
  const visible = applySort(filteredTasks, sortBy);

  return (
    <main className="min-h-screen relative bg-[#050e24] text-slate-100 overflow-x-hidden">
      {/* Dot grid background */}
      <div className="pointer-events-none fixed inset-0 dot-grid opacity-100" />

      {/* Glow orbs */}
      <div className="pointer-events-none fixed -top-40 -left-40 w-[700px] h-[500px] rounded-full bg-blue-600/15 blur-[140px] anim-glow" />
      <div className="pointer-events-none fixed -bottom-60 -right-40 w-[600px] h-[600px] rounded-full bg-blue-800/15 blur-[120px] anim-glow" style={{ animationDelay: "2s" }} />
      <div className="pointer-events-none fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[400px] h-[400px] rounded-full bg-indigo-900/10 blur-[100px]" />

      <Toast toasts={toasts} />
      {newTaskOpen && <NewTaskModal onClose={() => setNewTaskOpen(false)} onCreated={() => refresh({ silent: true })} toast={addToast} />}

      <div className="relative max-w-4xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-8 gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <AppLogo size="md" />
            <div>
              <h1 className="text-2xl font-bold tracking-tight bg-gradient-to-r from-white to-blue-200 bg-clip-text text-transparent">Task Tracker</h1>
              <p className="text-slate-500 text-xs">
                Updated {timeAgo(lastRefresh.toISOString())}
                {userEmail && <span className="hidden sm:inline"> · {userEmail}</span>}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => refresh()} disabled={refreshing} className="inline-flex items-center gap-2 bg-slate-800/80 border border-slate-700/60 hover:bg-slate-700/80 hover:border-slate-600 text-slate-400 hover:text-slate-200 font-medium text-sm px-4 py-2.5 rounded-xl shadow-sm transition-all disabled:opacity-60 active:scale-[0.98]">
              <IconRefresh spinning={refreshing} />
              <span className="hidden sm:inline">{refreshing ? "Refreshing..." : "Refresh"}</span>
            </button>
            <button onClick={() => setNewTaskOpen(true)} className="inline-flex items-center gap-2 bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 hover:shadow-xl hover:shadow-blue-500/30 hover:-translate-y-0.5 text-white font-semibold text-sm px-5 py-2.5 rounded-xl shadow-lg shadow-blue-500/20 transition-all active:scale-[0.98]">
              <IconPlus /> New Task
            </button>
            <button onClick={signOut} disabled={signingOut} className="inline-flex items-center gap-2 bg-slate-800/80 border border-slate-700/60 hover:bg-slate-700/80 hover:text-rose-400 text-slate-400 font-medium text-sm px-3.5 py-2.5 rounded-xl shadow-sm transition-all disabled:opacity-60 active:scale-[0.98]">
              {signingOut ? <IconSpinner /> : <IconLogout />}
              <span className="hidden sm:inline">{signingOut ? "Signing out..." : "Sign out"}</span>
            </button>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-6">
          {[
            { label: "Active",       count: counts.active,             color: "text-blue-400",    glow: "shadow-blue-500/10",    border: "border-blue-500/20" },
            { label: "Needs Review", count: counts.pending_review,     color: "text-amber-400",   glow: "shadow-amber-500/10",   border: "border-amber-500/20" },
            { label: "Revision",     count: counts.revision_requested, color: "text-orange-400",  glow: "shadow-orange-500/10",  border: "border-orange-500/20" },
            { label: "Done",         count: counts.completed,          color: "text-emerald-400", glow: "shadow-emerald-500/10", border: "border-emerald-500/20" },
            { label: "Escalated",    count: counts.escalated,          color: "text-rose-400",    glow: "shadow-rose-500/10",    border: "border-rose-500/20" },
          ].map((s, i) => (
            <div key={s.label} className={`bg-slate-900/60 backdrop-blur-xl rounded-2xl p-4 border ${s.border} shadow-lg ${s.glow} text-center anim-rise hover:-translate-y-0.5 hover:shadow-xl transition-all duration-200`} style={{ animationDelay: `${i * 60}ms` }}>
              <p className="text-slate-500 text-xs mb-1">{s.label}</p>
              <p className={`text-2xl font-bold ${s.color}`}>{s.count}</p>
            </div>
          ))}
        </div>

        {/* Filter tabs */}
        <div className="flex gap-1.5 mb-4 overflow-x-auto pb-1">
          {FILTERS.map(f => (
            <button
              key={f.key}
              onClick={() => { setFilter(f.key); if (f.key === "all") setSortBy("status"); }}
              className={`shrink-0 px-4 py-2 rounded-xl text-sm font-medium transition-all flex items-center gap-1.5 ${
                filter === f.key
                  ? "bg-gradient-to-r from-blue-600 to-blue-700 text-white shadow-lg shadow-blue-500/25"
                  : "bg-slate-800/60 border border-slate-700/40 text-slate-400 hover:text-slate-200 hover:bg-slate-700/60 hover:border-slate-600/60"
              }`}
            >
              {f.key === "by_employee" ? <IconUser /> : null}
              {f.label}
              {f.key !== "by_employee" && counts[f.key] > 0 && (
                <span className={`text-xs px-1.5 py-0.5 rounded-full ${filter === f.key ? "bg-white/20 text-white" : "bg-slate-700 text-slate-400"}`}>
                  {counts[f.key]}
                </span>
              )}
              {f.key === "pending_review" && counts.pending_review > 0 && (
                <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
              )}
            </button>
          ))}
        </div>

        {/* Sort controls */}
        {filter !== "by_employee" && (
          <div className="flex items-center gap-2 mb-5">
            <span className="text-xs text-slate-600 shrink-0">Sort:</span>
            {filter === "all" && (
              <button onClick={() => setSortBy("status")} className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${sortBy === "status" ? "bg-blue-600/20 border-blue-500/40 text-blue-300" : "bg-slate-800/60 border-slate-700/40 text-slate-500 hover:text-slate-300"}`}>
                By Status
              </button>
            )}
            <button onClick={() => setSortBy("date_desc")} className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${sortBy === "date_desc" ? "bg-blue-600/20 border-blue-500/40 text-blue-300" : "bg-slate-800/60 border-slate-700/40 text-slate-500 hover:text-slate-300"}`}>
              Newest First
            </button>
            <button onClick={() => setSortBy("date_asc")} className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${sortBy === "date_asc" ? "bg-blue-600/20 border-blue-500/40 text-blue-300" : "bg-slate-800/60 border-slate-700/40 text-slate-500 hover:text-slate-300"}`}>
              Oldest First
            </button>
          </div>
        )}

        {/* Task list or employee view */}
        {filter === "by_employee" ? (
          <EmployeeView tasks={tasks} sortBy={sortBy} expandedId={expandedId} onToggle={id => setExpandedId(expandedId === id ? null : id)} onAction={handleAction} />
        ) : (
          <div className="space-y-3">
            {visible.length === 0 && (
              <div className="text-center text-slate-500 py-16 bg-slate-900/40 backdrop-blur-xl rounded-2xl border border-slate-700/30">
                {filter === "all" ? "No tasks yet. Create one above!" : `No ${filter.replace(/_/g, " ")} tasks.`}
              </div>
            )}
            {visible.map((task, i) => (
              <div key={task.id} className="anim-rise" style={{ animationDelay: `${Math.min(i, 8) * 50}ms` }}>
                <TaskCard task={task} expanded={expandedId === task.id} onToggle={() => setExpandedId(expandedId === task.id ? null : task.id)} onAction={handleAction} />
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
