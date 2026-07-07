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

const GRADIENT_BG = "linear-gradient(180deg, #060d24 0%, #0d2f7a 28%, #1565c0 56%, #1e88e5 76%, #42a5f5 100%)";

// Deterministic per-employee color palette — stable across renders
const EMP_PALETTE = [
  "#10b981", // emerald
  "#8b5cf6", // violet
  "#ec4899", // pink
  "#f59e0b", // amber
  "#06b6d4", // cyan
  "#f97316", // orange
  "#14b8a6", // teal
  "#6366f1", // indigo
  "#ef4444", // red
  "#22c55e", // green
];

function getEmployeeColor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return EMP_PALETTE[Math.abs(h) % EMP_PALETTE.length];
}

const STATUS = {
  active:             { label: "Active",        badge: "bg-blue-100 text-blue-700 border-blue-200",       dot: "bg-blue-500" },
  pending_review:     { label: "Needs Review",  badge: "bg-amber-100 text-amber-700 border-amber-200",    dot: "bg-amber-500" },
  revision_requested: { label: "Revision Sent", badge: "bg-orange-100 text-orange-700 border-orange-200", dot: "bg-orange-500" },
  completed:          { label: "Done",          badge: "bg-emerald-100 text-emerald-700 border-emerald-200", dot: "bg-emerald-500" },
  escalated:          { label: "Escalated",     badge: "bg-rose-100 text-rose-700 border-rose-200",       dot: "bg-rose-500" },
  cancelled:          { label: "Cancelled",     badge: "bg-slate-100 text-slate-500 border-slate-200",    dot: "bg-slate-400" },
} as const;

// "By Employee" lives in the header button only — not in this tab row
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

function formatDate(d: string) {
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatDateTime(d: string) {
  return new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
}

function nextInLabel(d: string | null): { label: string; isOverdue: boolean } | null {
  if (!d) return null;
  const diff = new Date(d).getTime() - Date.now();
  if (diff < 0) {
    return { label: `Overdue · ${formatDateTime(d)}`, isOverdue: true };
  }
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const label = h > 0 ? `Next in ${h}h ${m}m · ${formatDateTime(d)}` : `Next in ${m}m · ${formatDateTime(d)}`;
  return { label, isOverdue: false };
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

// Parse Slack mrkdwn mention syntax for display
function parseSlackContent(text: string, userMap: Record<string, string>): string {
  return text
    .replace(/<@([A-Z0-9]+)>/g, (_, id) => `@${userMap[id] ?? id}`)
    .replace(/<([^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<([^>]+)>/g, "$1");
}

// ── Surface styles: solid light cards that stand out from the gradient bg ────

const CARD = "bg-white border border-slate-200 shadow-xl shadow-black/10";
const CARD_HOVER = "hover:shadow-2xl hover:shadow-black/15 hover:border-slate-300";
const INPUT_CLS = "w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm text-slate-800 placeholder-slate-400 hover:border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 transition-all";
const HEADER_BTN = "bg-white/95 border border-white hover:bg-white text-slate-700 shadow-lg";

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
function IconSpinner() {
  return (
    <svg className="w-4 h-4 anim-spin-slow" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}
function IconBarChart() {
  return <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="12" width="4" height="9" rx="1" /><rect x="10" y="7" width="4" height="14" rx="1" /><rect x="17" y="3" width="4" height="18" rx="1" /></svg>;
}

// ── Toast ───────────────────────────────────────────────────────────────────

function Toast({ toasts }: { toasts: ToastType[] }) {
  if (!toasts.length) return null;
  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map(t => (
        <div key={t.id} className={`px-4 py-3 rounded-xl text-sm font-medium shadow-xl border ${
          t.ok ? "bg-emerald-50 border-emerald-300 text-emerald-800" : "bg-rose-50 border-rose-300 text-rose-800"
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
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className={`${CARD} rounded-2xl w-full max-w-sm p-6 anim-pop`}>
        <h3 className="text-base font-semibold text-slate-900 mb-2">{title}</h3>
        <p className="text-sm text-slate-500 mb-6 leading-relaxed">{body}</p>
        <div className="flex gap-3">
          <button onClick={onClose} className="flex-1 bg-slate-100 border border-slate-200 hover:bg-slate-200 text-slate-700 font-medium text-sm py-2.5 rounded-xl transition-all active:scale-[0.98]">
            Keep as is
          </button>
          <button
            onClick={() => { onConfirm(); onClose(); }}
            className={`flex-1 font-semibold text-sm py-2.5 rounded-xl text-white transition-all active:scale-[0.98] shadow-lg ${
              danger ? "bg-rose-600 hover:bg-rose-700 shadow-rose-500/25" : "bg-blue-600 hover:bg-blue-700 shadow-blue-500/25"
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

function CommentBubble({ c, userMap }: { c: TaskComment; userMap: Record<string, string> }) {
  const content = parseSlackContent(c.content, userMap);

  if (c.author_type === "system") {
    return (
      <div className="flex justify-center my-1">
        <span className="text-xs text-slate-500 italic px-3 py-1 bg-slate-100 rounded-full text-center border border-slate-200">
          {content} · {timeAgo(c.created_at)}
        </span>
      </div>
    );
  }
  const isBrandon = c.author_type === "brandon";
  return (
    <div className={`flex gap-2 ${isBrandon ? "flex-row-reverse" : "flex-row"}`}>
      <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
        isBrandon ? "bg-blue-600 text-white" : "bg-slate-200 text-slate-600"
      }`}>
        {c.author_name.charAt(0).toUpperCase()}
      </div>
      <div className={`max-w-[75%] ${isBrandon ? "items-end" : "items-start"} flex flex-col`}>
        <span className="text-xs text-slate-400 mb-1 px-1">{c.author_name} · {timeAgo(c.created_at)}</span>
        <div className={`px-3.5 py-2 rounded-2xl text-sm leading-relaxed ${
          isBrandon
            ? "bg-blue-600 text-white rounded-tr-sm shadow-md shadow-blue-500/20"
            : "bg-slate-100 border border-slate-200 text-slate-700 rounded-tl-sm"
        }`}>
          {content}
        </div>
      </div>
    </div>
  );
}

// ── Task Card ───────────────────────────────────────────────────────────────

function TaskCard({ task, expanded, onToggle, onAction, userMap, accentColor }: {
  task: TaskWithComments;
  expanded: boolean;
  onToggle: () => void;
  onAction: (taskId: string, action: TaskAction, content?: string) => Promise<void>;
  userMap: Record<string, string>;
  accentColor?: string;
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
  const assigneeDisplay = (task.assignee_names?.length ? task.assignee_names : [task.assigned_to_name]).join(", ");
  const next = nextInLabel(isOpen ? task.next_followup_at : null);

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
    <div
      className={`rounded-2xl transition-all duration-200 ${CARD} ${CARD_HOVER} ${
        isPendingReview ? "ring-2 ring-amber-400/60 border-amber-300" : ""
      }`}
      style={accentColor ? { borderLeft: `4px solid ${accentColor}` } : undefined}
    >
      {confirm === "cancel" && (
        <ConfirmDialog title="Cancel this task?" body={`${assigneeDisplay} will be notified in Slack that the task is cancelled, and all follow-ups will stop.`} confirmLabel="Yes, cancel task" danger onConfirm={() => handle("cancel")} onClose={() => setConfirm(null)} />
      )}
      {confirm === "reopen" && (
        <ConfirmDialog title="Reopen this task?" body={`${assigneeDisplay} will be notified in Slack that the task is active again, and the follow-up schedule will restart.`} confirmLabel="Yes, reopen task" onConfirm={() => handle("reopen")} onClose={() => setConfirm(null)} />
      )}
      {confirm === "followup_now" && (
        <ConfirmDialog
          title="Send a follow-up right now?"
          body={followupsLeft > 0 ? `This sends follow-up #${task.followup_count + 1} of ${task.max_followups} to ${assigneeDisplay} immediately.` : `All ${task.max_followups} follow-ups are used. Sending now will ESCALATE the task and DM Brandon.`}
          confirmLabel={followupsLeft > 0 ? "Send follow-up" : "Escalate now"}
          danger={followupsLeft <= 0}
          onConfirm={() => handle("followup_now")}
          onClose={() => setConfirm(null)}
        />
      )}

      {/* Card header */}
      <button onClick={onToggle} className="w-full text-left p-5 flex items-start gap-4 rounded-2xl transition-colors hover:bg-slate-50/70">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5 flex-wrap">
            <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-0.5 rounded-full border ${cfg.badge}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot} ${isPendingReview ? "animate-pulse" : ""}`} />
              {cfg.label}
            </span>
            {isPendingReview && <span className="text-xs font-medium text-amber-600">Awaiting your review</span>}
          </div>
          <p className="font-semibold text-slate-900 leading-snug">{task.task_text}</p>
          <p className="text-sm text-slate-500 mt-1 flex items-center gap-1.5 flex-wrap">
            {accentColor && <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: accentColor }} />}
            <span className="text-slate-700 font-medium">{assigneeDisplay}</span>
            <span className="text-slate-300">·</span>
            assigned by {task.assigned_by_name}
          </p>
          <p className="text-xs text-slate-400 mt-0.5">{formatDate(task.created_at)} · {timeAgo(task.created_at)}</p>
        </div>

        <div className="text-right shrink-0 flex flex-col items-end gap-1">
          <span className="text-xs text-slate-400">{task.followup_count}/{task.max_followups} follow-ups</span>
          {next && (
            <span className={`text-xs font-medium ${next.isOverdue ? "text-rose-600" : "text-blue-600"}`}>
              {next.label}
            </span>
          )}
          {task.status === "completed" && task.completed_at && (
            <span className="text-xs text-emerald-600">Completed {timeAgo(task.completed_at)}</span>
          )}
          {task.status === "escalated" && task.escalated_at && (
            <span className="text-xs text-rose-600">Escalated {timeAgo(task.escalated_at)}</span>
          )}
          <svg className={`w-4 h-4 text-slate-400 mt-1 transition-transform ${expanded ? "rotate-180" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </div>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-slate-200 px-5 pb-5 pt-4 anim-expand">
          {/* Thread history */}
          <div className="mb-4">
            <p className="text-xs text-slate-400 font-semibold uppercase tracking-wide mb-3">Thread Activity</p>
            {sortedComments.length > 0 ? (
              <div ref={threadRef} className="flex flex-col gap-3 max-h-72 overflow-y-auto pr-1 hide-scrollbar bg-slate-50 border border-slate-200 rounded-xl p-3">
                {sortedComments.map(c => <CommentBubble key={c.id} c={c} userMap={userMap} />)}
              </div>
            ) : (
              <p className="text-sm text-slate-400 italic text-center py-4 bg-slate-50 rounded-xl border border-slate-200">
                No thread activity yet — Slack replies and actions will appear here.
              </p>
            )}
          </div>

          {/* pending_review actions */}
          {isPendingReview && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm text-amber-700 font-medium bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5">
                <span>👀</span>
                <span>{assigneeDisplay} says this is done. Approve it, or describe what needs revising.</span>
              </div>
              <textarea
                value={revisionText}
                onChange={e => setRevisionText(e.target.value)}
                placeholder="Describe what needs to be changed or fixed..."
                className={`${INPUT_CLS} resize-none`}
                rows={3}
              />
              <div className="flex gap-3">
                <button disabled={!!working} onClick={() => handle("approve")} className="flex-1 inline-flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-700 hover:-translate-y-0.5 disabled:opacity-50 text-white font-semibold text-sm py-2.5 rounded-xl shadow-lg shadow-emerald-500/25 transition-all active:scale-[0.98]">
                  <IconCheck /> {working === "approve" ? "Approving..." : "Approve & Close"}
                </button>
                <button disabled={!!working || !revisionText.trim()} onClick={() => handle("revision")} className="flex-1 inline-flex items-center justify-center gap-2 bg-orange-500 hover:bg-orange-600 hover:-translate-y-0.5 disabled:opacity-50 text-white font-semibold text-sm py-2.5 rounded-xl shadow-lg shadow-orange-500/25 transition-all active:scale-[0.98]">
                  <IconEdit /> {working === "revision" ? "Sending..." : "Request Revision"}
                </button>
              </div>
              <button disabled={!!working} onClick={() => setConfirm("cancel")} className="w-full inline-flex items-center justify-center gap-2 bg-white border border-rose-300 hover:bg-rose-50 text-rose-600 font-medium text-sm py-2.5 rounded-xl transition-all disabled:opacity-50 active:scale-[0.98]">
                <IconTrash /> Cancel Task
              </button>
            </div>
          )}

          {/* Open task actions */}
          {isOpen && (
            <div className="space-y-3">
              <div className="flex gap-3">
                <button disabled={!!working} onClick={() => setConfirm("followup_now")} className="flex-1 inline-flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 hover:-translate-y-0.5 disabled:opacity-50 text-white font-semibold text-sm py-2.5 rounded-xl shadow-lg shadow-blue-500/25 transition-all active:scale-[0.98]">
                  <IconBolt /> {working === "followup_now" ? "Sending..." : "Send Follow-up Now"}
                </button>
                <button disabled={!!working} onClick={() => setConfirm("cancel")} className="flex-1 inline-flex items-center justify-center gap-2 bg-white border border-rose-300 hover:bg-rose-50 text-rose-600 font-medium text-sm py-2.5 rounded-xl transition-all disabled:opacity-50 active:scale-[0.98]">
                  <IconTrash /> {working === "cancel" ? "Cancelling..." : "Cancel Task"}
                </button>
              </div>

              {isActive && (
                <div className="pt-3 border-t border-slate-200">
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={messageText}
                      onChange={e => setMessageText(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter" && messageText.trim() && !working) handle("message"); }}
                      placeholder={`Message ${assigneeDisplay} in the Slack thread...`}
                      className={INPUT_CLS.replace("py-2.5", "py-2")}
                    />
                    <button
                      disabled={!!working || !messageText.trim()}
                      onClick={() => handle("message")}
                      className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 hover:-translate-y-0.5 disabled:opacity-40 text-white font-semibold text-sm px-4 py-2 rounded-xl shadow-md shadow-blue-500/20 transition-all active:scale-[0.98]"
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
            <button disabled={!!working} onClick={() => setConfirm("reopen")} className="w-full inline-flex items-center justify-center gap-2 bg-white border border-blue-300 hover:bg-blue-50 text-blue-600 font-medium text-sm py-2.5 rounded-xl transition-all disabled:opacity-50 active:scale-[0.98]">
              <IconRefresh spinning={working === "reopen"} /> {working === "reopen" ? "Reopening..." : "Reopen Task"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Employee view ─────────────────────────────────────────────────────────────

function EmployeeView({ tasks, sortBy, expandedId, onToggle, onAction, userMap }: {
  tasks: TaskWithComments[];
  sortBy: SortBy;
  expandedId: string | null;
  onToggle: (id: string) => void;
  onAction: (taskId: string, action: TaskAction, content?: string) => Promise<void>;
  userMap: Record<string, string>;
}) {
  const grouped = groupByEmployee(tasks);
  const employees = Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b));

  if (employees.length === 0) {
    return (
      <div className={`text-center text-slate-500 py-16 ${CARD} rounded-2xl`}>
        No tasks assigned yet.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {employees.map(([name, empTasks]) => {
        const color = getEmployeeColor(name);
        const total = empTasks.length;
        const active = empTasks.filter(t => t.status === "active").length;
        const pending = empTasks.filter(t => t.status === "pending_review").length;
        const revision = empTasks.filter(t => t.status === "revision_requested").length;
        const done = empTasks.filter(t => t.status === "completed").length;
        const escalated = empTasks.filter(t => t.status === "escalated").length;
        const cancelled = empTasks.filter(t => t.status === "cancelled").length;
        const completionRate = total > 0 ? Math.round((done / total) * 100) : 0;
        const completedTasks = empTasks.filter(t => t.status === "completed");
        const avgFollowups = completedTasks.length > 0
          ? (completedTasks.reduce((s, t) => s + t.followup_count, 0) / completedTasks.length).toFixed(1)
          : "—";
        const openTasks = active + pending + revision;

        return (
          <div key={name} className={`rounded-2xl ${CARD} overflow-hidden`}
            style={{ borderLeft: `5px solid ${color}` }}>
            {/* Employee header */}
            <div className="px-5 py-4 border-b border-slate-200" style={{ background: color + "0d" }}>
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full flex items-center justify-center font-bold text-white text-base shadow-md"
                    style={{ background: color }}>
                    {name.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <h3 className="font-bold text-slate-900 text-base flex items-center gap-2">
                      {name}
                      <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color }} />
                    </h3>
                    <p className="text-xs text-slate-500">{total} task{total !== 1 ? "s" : ""} total</p>
                  </div>
                </div>

                {/* Status pill row */}
                <div className="flex gap-2 text-xs flex-wrap">
                  {active > 0    && <span className="px-2.5 py-1 rounded-full bg-blue-100 text-blue-700 border border-blue-200">{active} active</span>}
                  {pending > 0   && <span className="px-2.5 py-1 rounded-full bg-amber-100 text-amber-700 border border-amber-200">{pending} review</span>}
                  {revision > 0  && <span className="px-2.5 py-1 rounded-full bg-orange-100 text-orange-700 border border-orange-200">{revision} revision</span>}
                  {done > 0      && <span className="px-2.5 py-1 rounded-full bg-emerald-100 text-emerald-700 border border-emerald-200">{done} done</span>}
                  {escalated > 0 && <span className="px-2.5 py-1 rounded-full bg-rose-100 text-rose-700 border border-rose-200">{escalated} escalated</span>}
                  {cancelled > 0 && <span className="px-2.5 py-1 rounded-full bg-slate-100 text-slate-500 border border-slate-200">{cancelled} cancelled</span>}
                </div>
              </div>

              {/* Productivity metrics */}
              <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="bg-white rounded-xl px-3 py-2.5 border border-slate-200 shadow-sm">
                  <p className="text-slate-400 text-xs mb-0.5">Completion Rate</p>
                  <p className="text-slate-900 font-bold text-lg leading-none">{completionRate}%</p>
                  <div className="mt-2 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                    <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(completionRate, 100)}%`, backgroundColor: color }} />
                  </div>
                </div>
                <div className="bg-white rounded-xl px-3 py-2.5 border border-slate-200 shadow-sm">
                  <p className="text-slate-400 text-xs mb-0.5">Open Tasks</p>
                  <p className="text-slate-900 font-bold text-lg leading-none">{openTasks}</p>
                  <p className="text-slate-400 text-xs mt-1">of {total} total</p>
                </div>
                <div className="bg-white rounded-xl px-3 py-2.5 border border-slate-200 shadow-sm">
                  <p className="text-slate-400 text-xs mb-0.5">Avg Follow-ups</p>
                  <p className="text-slate-900 font-bold text-lg leading-none">{avgFollowups}</p>
                  <p className="text-slate-400 text-xs mt-1">per completed task</p>
                </div>
                <div className="bg-white rounded-xl px-3 py-2.5 border border-slate-200 shadow-sm">
                  <p className="text-slate-400 text-xs mb-0.5">Completed</p>
                  <p className="text-slate-900 font-bold text-lg leading-none">{done}</p>
                  <p className="text-slate-400 text-xs mt-1">{escalated > 0 ? `${escalated} escalated` : "no escalations"}</p>
                </div>
              </div>
            </div>

            {/* Task list — each card gets the employee accent color */}
            <div className="p-4 space-y-2 bg-slate-50/60">
              {applySort(empTasks, sortBy).map(task => (
                <TaskCard key={task.id} task={task} expanded={expandedId === task.id} onToggle={() => onToggle(task.id)} onAction={onAction} userMap={userMap} accentColor={color} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── New Task Modal ──────────────────────────────────────────────────────────

function NewTaskModal({ onClose, onCreated, toast, initialUsers }: {
  onClose: () => void; onCreated: () => void; toast: (msg: string, ok: boolean) => void;
  initialUsers: SlackUser[];
}) {
  const [users] = useState<SlackUser[]>(initialUsers);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [taskText, setTaskText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [userSearch, setUserSearch] = useState("");
  const [followups, setFollowups] = useState<string[]>([""]);
  const [dueDateMode, setDueDateMode] = useState<"open" | "custom">("open");
  const [dueDateVal, setDueDateVal] = useState("");

  const filteredUsers = userSearch
    ? users.filter(u => u.name.toLowerCase().includes(userSearch.toLowerCase()))
    : users;

  function toggleUser(u: SlackUser) {
    setSelectedIds(prev => prev.includes(u.id) ? prev.filter(id => id !== u.id) : [...prev, u.id]);
  }
  function addFollowup() { setFollowups(prev => [...prev, ""]); }
  function removeFollowup(i: number) { setFollowups(prev => prev.filter((_, idx) => idx !== i)); }
  function setFollowupAt(i: number, val: string) {
    setFollowups(prev => { const n = [...prev]; n[i] = val; return n; });
  }
  // Sort followups chronologically when user leaves an input (onBlur)
  function sortFollowups() {
    setFollowups(prev => {
      const filled = prev.filter(f => f.trim()).sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
      const empty = prev.filter(f => !f.trim());
      return [...filled, ...empty];
    });
  }

  const dueMs = dueDateMode === "custom" && dueDateVal ? new Date(dueDateVal).getTime() : null;
  const afterDueWarnings = followups.map(f => !f || !dueMs ? false : new Date(f).getTime() > dueMs);
  const outOfOrderWarnings = followups.map((f, i) => {
    if (!f || i === 0) return false;
    const prev = followups[i - 1];
    if (!prev) return false;
    return new Date(f).getTime() < new Date(prev).getTime();
  });
  const hasWarning = afterDueWarnings.some(Boolean) || outOfOrderWarnings.some(Boolean);
  const filledFollowups = followups.filter(f => f.trim());

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedIds.length || !taskText.trim() || hasWarning || filledFollowups.length === 0) return;
    const selectedUsers = selectedIds.map(id => users.find(u => u.id === id)!).filter(Boolean);
    // Always sort chronologically before submitting
    const followupSchedule = filledFollowups
      .sort((a, b) => new Date(a).getTime() - new Date(b).getTime())
      .map(f => new Date(f).toISOString());
    const dueDate = dueDateMode === "custom" && dueDateVal ? new Date(dueDateVal).toISOString() : null;
    setSubmitting(true);
    try {
      const res = await fetch("/api/tasks", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ assigneeIds: selectedUsers.map(u => u.id), assigneeNames: selectedUsers.map(u => u.name), taskText, followupSchedule, dueDate }),
      });
      if (res.ok) { toast("Task created and posted to Slack", true); onCreated(); onClose(); }
      else { const d = await res.json(); toast(d.error ?? "Failed to create task", false); }
    } catch { toast("Network error — please try again", false); }
    finally { setSubmitting(false); }
  }

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-40 flex items-start justify-center p-4 overflow-y-auto">
      <div className={`${CARD} rounded-3xl w-full max-w-lg anim-pop my-4`}>
        <div className="flex items-center justify-between p-6 border-b border-slate-200">
          <h2 className="text-lg font-semibold text-slate-900">Assign New Task</h2>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-slate-100 hover:bg-slate-200 text-slate-500 flex items-center justify-center transition-all hover:rotate-90 duration-200">
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <form onSubmit={submit} className="p-6 space-y-5">
          {/* Assignees */}
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-2">Assign to <span className="text-slate-400">(select one or more)</span></label>
            <div className="space-y-2">
              <input type="text" placeholder="Search team members..." value={userSearch} onChange={e => setUserSearch(e.target.value)} className={INPUT_CLS} />
              {selectedIds.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {selectedIds.map(id => {
                    const u = users.find(u => u.id === id);
                    if (!u) return null;
                    const c = getEmployeeColor(u.name);
                    return (
                      <span key={id} className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold text-white shadow-sm" style={{ background: c }}>
                        {u.name}
                        <button type="button" onClick={() => toggleUser(u)} className="text-white/70 hover:text-white transition-colors">
                          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
                        </button>
                      </span>
                    );
                  })}
                </div>
              )}
              <div className="max-h-36 overflow-y-auto bg-slate-50 border border-slate-200 rounded-xl divide-y divide-slate-200 hide-scrollbar">
                {filteredUsers.length === 0 && <p className="text-sm text-slate-400 p-3 text-center">No members found</p>}
                {filteredUsers.map(u => {
                  const sel = selectedIds.includes(u.id);
                  return (
                    <button key={u.id} type="button" onClick={() => toggleUser(u)}
                      className={`w-full text-left px-4 py-2.5 text-sm flex items-center justify-between transition-colors ${sel ? "bg-blue-50 text-blue-700 font-medium" : "text-slate-600 hover:bg-slate-100"}`}
                    >
                      <span className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: getEmployeeColor(u.name) }} />
                        {u.name}
                      </span>
                      {sel && <svg className="w-4 h-4 text-blue-600 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Task description */}
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-2">Task description</label>
            <textarea required value={taskText} onChange={e => setTaskText(e.target.value)}
              placeholder="e.g. Prepare the supplier outreach plan by Friday"
              className={`${INPUT_CLS} resize-none`} rows={3} />
          </div>

          {/* Due date */}
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-2">Due date</label>
            <div className="flex gap-2 mb-2">
              {(["open", "custom"] as const).map(m => (
                <button key={m} type="button" onClick={() => setDueDateMode(m)}
                  className={`px-4 py-1.5 rounded-lg text-sm font-medium border transition-all ${dueDateMode === m ? "bg-blue-600 border-blue-600 text-white shadow-md shadow-blue-500/20" : "bg-white border-slate-200 text-slate-500 hover:border-slate-300 hover:text-slate-700"}`}
                >
                  {m === "open" ? "Open (no due date)" : "Custom date"}
                </button>
              ))}
            </div>
            {dueDateMode === "custom" && (
              <input type="datetime-local" value={dueDateVal} onChange={e => setDueDateVal(e.target.value)} className={INPUT_CLS} />
            )}
          </div>

          {/* Follow-up schedule */}
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-2">Follow-up schedule</label>
            <div className="space-y-2">
              {followups.map((f, i) => {
                const isAfterDue = afterDueWarnings[i];
                const isOutOfOrder = outOfOrderWarnings[i];
                const hasFieldWarning = isAfterDue || isOutOfOrder;
                const ordinal = ["1st","2nd","3rd"][i] ?? `${i + 1}th`;
                return (
                  <div key={i} className="flex gap-2 items-end">
                    <div className="flex-1">
                      <p className="text-xs text-slate-400 mb-1 flex items-center gap-2">
                        <span>{ordinal} Follow-up</span>
                        {isAfterDue && <span className="text-rose-500 font-medium">⚠ After due date</span>}
                        {isOutOfOrder && !isAfterDue && <span className="text-amber-600 font-medium">⚠ Earlier than previous — will auto-sort</span>}
                      </p>
                      <input
                        type="datetime-local"
                        value={f}
                        onChange={e => setFollowupAt(i, e.target.value)}
                        onBlur={sortFollowups}
                        className={`${INPUT_CLS} ${hasFieldWarning ? "border-rose-400" : ""}`}
                      />
                    </div>
                    {followups.length > 1 && (
                      <button type="button" onClick={() => removeFollowup(i)}
                        className="w-9 h-9 rounded-lg bg-rose-50 border border-rose-200 text-rose-500 hover:bg-rose-100 flex items-center justify-center transition-all shrink-0">
                        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
                      </button>
                    )}
                  </div>
                );
              })}
              <button type="button" onClick={addFollowup}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-600 hover:text-blue-700 bg-blue-50 border border-blue-200 hover:border-blue-300 px-3 py-1.5 rounded-lg transition-all">
                <IconPlus /> Add follow-up
              </button>
            </div>
          </div>

          <div className="flex gap-3 pt-1">
            <button type="button" onClick={onClose} className="flex-1 bg-slate-100 border border-slate-200 hover:bg-slate-200 text-slate-700 font-medium text-sm py-3 rounded-xl transition-all active:scale-[0.98]">
              Cancel
            </button>
            <button type="submit" disabled={!selectedIds.length || !taskText.trim() || filledFollowups.length === 0 || hasWarning || submitting}
              className="flex-1 bg-blue-600 hover:bg-blue-700 hover:-translate-y-0.5 disabled:opacity-50 text-white font-semibold text-sm py-3 rounded-xl shadow-lg shadow-blue-500/25 transition-all active:scale-[0.98]">
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
  const [users, setUsers] = useState<SlackUser[]>([]);
  const [userMap, setUserMap] = useState<Record<string, string>>({});
  const toastIdRef = useRef(0);

  // Load users for mention resolution and modal
  useEffect(() => {
    fetch("/api/slack/users", { cache: "no-store" })
      .then(r => r.json())
      .then(d => {
        const members: SlackUser[] = d.members ?? [];
        setUsers(members);
        const map: Record<string, string> = {};
        for (const u of members) map[u.id] = u.name;
        setUserMap(map);
      })
      .catch(() => {});
  }, []);

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
  const isEmployeeView = filter === "by_employee";

  return (
    <main className="min-h-screen relative text-white overflow-x-hidden">
      {/* Fixed gradient background — stays put while the page scrolls */}
      <div className="fixed inset-0 -z-10" style={{ background: GRADIENT_BG }} />

      <Toast toasts={toasts} />
      {newTaskOpen && (
        <NewTaskModal
          onClose={() => setNewTaskOpen(false)}
          onCreated={() => refresh({ silent: true })}
          toast={addToast}
          initialUsers={users}
        />
      )}

      <div className="relative max-w-4xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-8 gap-3 flex-wrap">
          <div>
            <h1 className="text-4xl font-black tracking-tight leading-none text-white drop-shadow-md">
              Task{" "}
              <span style={{ background: "linear-gradient(90deg, #7dd3fc, #bae6fd, #e0f2fe)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
                Tracker
              </span>
            </h1>
            <p className="text-blue-100/70 text-xs mt-1 drop-shadow">
              Updated {timeAgo(lastRefresh.toISOString())}
              {userEmail && <span className="hidden sm:inline"> · {userEmail}</span>}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={() => refresh()} disabled={refreshing} className={`inline-flex items-center gap-2 ${HEADER_BTN} font-medium text-sm px-4 py-2.5 rounded-xl transition-all disabled:opacity-60 active:scale-[0.98]`}>
              <IconRefresh spinning={refreshing} />
              <span className="hidden sm:inline">{refreshing ? "Refreshing..." : "Refresh"}</span>
            </button>
            <button
              onClick={() => setFilter(isEmployeeView ? "all" : "by_employee")}
              className={`inline-flex items-center gap-2 font-medium text-sm px-4 py-2.5 rounded-xl transition-all active:scale-[0.98] shadow-lg ${
                isEmployeeView
                  ? "bg-indigo-600 border border-indigo-500 text-white shadow-indigo-500/30"
                  : HEADER_BTN
              }`}
            >
              <IconBarChart />
              <span className="hidden sm:inline">By Employee</span>
            </button>
            <button onClick={() => setNewTaskOpen(true)} className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 border border-blue-500 hover:-translate-y-0.5 text-white font-semibold text-sm px-5 py-2.5 rounded-xl shadow-lg shadow-blue-900/40 transition-all active:scale-[0.98]">
              <IconPlus /> New Task
            </button>
            <button onClick={signOut} disabled={signingOut} className={`inline-flex items-center gap-2 ${HEADER_BTN} hover:text-rose-600 font-medium text-sm px-3.5 py-2.5 rounded-xl transition-all disabled:opacity-60 active:scale-[0.98]`}>
              {signingOut ? <IconSpinner /> : <IconLogout />}
              <span className="hidden sm:inline">{signingOut ? "Signing out..." : "Sign out"}</span>
            </button>
          </div>
        </div>

        {/* Stats — solid white cards */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-6">
          {[
            { label: "Active",       count: counts.active,             color: "text-blue-600" },
            { label: "Needs Review", count: counts.pending_review,     color: "text-amber-600" },
            { label: "Revision",     count: counts.revision_requested, color: "text-orange-600" },
            { label: "Done",         count: counts.completed,          color: "text-emerald-600" },
            { label: "Escalated",    count: counts.escalated,          color: "text-rose-600" },
          ].map((s, i) => (
            <div key={s.label} className={`${CARD} rounded-2xl p-4 text-center anim-rise hover:-translate-y-0.5 transition-all duration-200`} style={{ animationDelay: `${i * 60}ms` }}>
              <p className="text-slate-500 text-xs mb-1 font-medium">{s.label}</p>
              <p className={`text-2xl font-bold ${s.color}`}>{s.count}</p>
            </div>
          ))}
        </div>

        {/* Filter tabs — solid white pills, no scrollbar */}
        {!isEmployeeView && (
          <div className="flex gap-1.5 mb-4 flex-wrap">
            {FILTERS.map(f => (
              <button
                key={f.key}
                onClick={() => { setFilter(f.key); if (f.key === "all") setSortBy("status"); }}
                className={`shrink-0 px-3.5 py-1.5 rounded-xl text-sm font-medium transition-all flex items-center gap-1.5 shadow-md ${
                  filter === f.key
                    ? "bg-blue-600 border border-blue-500 text-white shadow-blue-900/30"
                    : "bg-white/95 border border-white text-slate-600 hover:bg-white hover:text-slate-900"
                }`}
              >
                {f.label}
                {counts[f.key] > 0 && (
                  <span className={`text-xs px-1.5 py-0.5 rounded-full ${filter === f.key ? "bg-white/25 text-white" : "bg-slate-100 text-slate-500"}`}>
                    {counts[f.key]}
                  </span>
                )}
                {f.key === "pending_review" && counts.pending_review > 0 && (
                  <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                )}
              </button>
            ))}
          </div>
        )}

        {/* Sort controls — solid white pills */}
        <div className="flex items-center gap-2 mb-5">
          <span className="text-xs text-blue-100/80 font-medium shrink-0 drop-shadow">Sort:</span>
          {filter === "all" && (
            <button onClick={() => setSortBy("status")} className={`text-xs px-3 py-1.5 rounded-lg border font-medium transition-all shadow-sm ${sortBy === "status" ? "bg-blue-600 border-blue-500 text-white" : "bg-white/95 border-white text-slate-600 hover:bg-white"}`}>
              By Status
            </button>
          )}
          <button onClick={() => setSortBy("date_desc")} className={`text-xs px-3 py-1.5 rounded-lg border font-medium transition-all shadow-sm ${sortBy === "date_desc" ? "bg-blue-600 border-blue-500 text-white" : "bg-white/95 border-white text-slate-600 hover:bg-white"}`}>
            Newest First
          </button>
          <button onClick={() => setSortBy("date_asc")} className={`text-xs px-3 py-1.5 rounded-lg border font-medium transition-all shadow-sm ${sortBy === "date_asc" ? "bg-blue-600 border-blue-500 text-white" : "bg-white/95 border-white text-slate-600 hover:bg-white"}`}>
            Oldest First
          </button>
        </div>

        {/* Task list or employee view */}
        {isEmployeeView ? (
          <EmployeeView tasks={tasks} sortBy={sortBy} expandedId={expandedId} onToggle={id => setExpandedId(expandedId === id ? null : id)} onAction={handleAction} userMap={userMap} />
        ) : (
          <div className="space-y-3">
            {visible.length === 0 && (
              <div className={`text-center text-slate-500 py-16 ${CARD} rounded-2xl`}>
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
                  userMap={userMap}
                  accentColor={getEmployeeColor(task.assigned_to_name)}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
