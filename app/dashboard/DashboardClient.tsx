"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowser } from "@/lib/supabase-browser";
import type { TeamTask } from "@/lib/supabase-team";

// ── Types ─────────────────────────────────────────────────────────────────────

type IdeaStatus = "active" | "in_progress" | "completed" | "parked" | "abandoned";
type IdeaPriority = "low" | "medium" | "high" | "critical";
type IdeaCategory = "business" | "product" | "personal" | "research" | "strategy" | "other";

interface Idea {
  id: string;
  title: string;
  summary: string | null;
  raw_input: string;
  status: IdeaStatus;
  category: IdeaCategory;
  priority: IdeaPriority;
  action_steps: string[] | null;
  next_reminder_at: string | null;
  reminder_frequency_hours: number;
  reminder_count: number;
  reminders_paused: boolean;
  due_date: string | null;
  research_results: string | null;
  created_at: string;
  completed_at: string | null;
}

interface IdeaUpdate {
  id: string;
  idea_id: string;
  update_type: string;
  content: string;
  created_at: string;
}

interface CompanionMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  thread_ts: string | null;
  created_at: string;
}

interface IdeaDetail extends Idea {
  idea_updates: IdeaUpdate[];
  companion_messages: CompanionMessage[];
}

// ── Status / priority maps ────────────────────────────────────────────────────

const IDEA_STATUS: Record<IdeaStatus, { label: string; dot: string; badge: string }> = {
  active:      { label: "Active",      dot: "bg-blue-500",    badge: "bg-blue-100 text-blue-700 border-blue-200" },
  in_progress: { label: "In Progress", dot: "bg-amber-500",   badge: "bg-amber-100 text-amber-700 border-amber-200" },
  completed:   { label: "Completed",   dot: "bg-emerald-500", badge: "bg-emerald-100 text-emerald-700 border-emerald-200" },
  parked:      { label: "Parked",      dot: "bg-slate-400",   badge: "bg-slate-100 text-slate-600 border-slate-200" },
  abandoned:   { label: "Abandoned",   dot: "bg-rose-400",    badge: "bg-rose-100 text-rose-600 border-rose-200" },
};

const PRIORITY: Record<IdeaPriority, { label: string; cls: string }> = {
  low:      { label: "Low",      cls: "bg-slate-100 text-slate-500 border-slate-200" },
  medium:   { label: "Medium",   cls: "bg-blue-100 text-blue-600 border-blue-200" },
  high:     { label: "High",     cls: "bg-orange-100 text-orange-600 border-orange-200" },
  critical: { label: "Critical", cls: "bg-rose-100 text-rose-700 border-rose-200" },
};

const TEAM_STATUS: Record<string, { label: string; dot: string }> = {
  active:             { label: "Active",        dot: "bg-blue-500" },
  revision_requested: { label: "Revision Sent", dot: "bg-orange-500" },
  completed:          { label: "Done",          dot: "bg-emerald-500" },
  cancelled:          { label: "Cancelled",     dot: "bg-slate-400" },
  escalated:          { label: "Escalated",     dot: "bg-rose-500" },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function doneThisWeek(ideas: Idea[]) {
  const weekAgo = Date.now() - 7 * 86400000;
  return ideas.filter(i => i.status === "completed" && i.completed_at && new Date(i.completed_at).getTime() > weekAgo).length;
}

// ── Style constants ───────────────────────────────────────────────────────────

const CARD = "bg-white border border-slate-200 shadow-sm";
const INPUT_CLS = "bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-[#0E90C8]/30 focus:border-[#0E90C8] transition-all";

// ── Idea Detail Panel ─────────────────────────────────────────────────────────

function IdeaPanel({ idea: initialIdea, onClose, onStatusChange }: {
  idea: Idea;
  onClose: () => void;
  onStatusChange: (id: string, status: IdeaStatus) => Promise<void>;
}) {
  const [detail, setDetail] = useState<IdeaDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [researchOpen, setResearchOpen] = useState(false);
  const [working, setWorking] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/companion/ideas/${initialIdea.id}`)
      .then(r => r.json())
      .then(d => { setDetail(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [initialIdea.id]);

  const idea = detail ?? initialIdea;
  const cfg = IDEA_STATUS[idea.status] ?? IDEA_STATUS.active;
  const priCfg = PRIORITY[idea.priority] ?? PRIORITY.medium;

  async function handleStatus(status: IdeaStatus) {
    setWorking(status);
    await onStatusChange(idea.id, status);
    setWorking(null);
    onClose();
  }

  const isOpen = idea.status === "active" || idea.status === "in_progress";
  const isClosed = idea.status === "completed" || idea.status === "parked" || idea.status === "abandoned";

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-end">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <div className="relative h-full w-full max-w-xl bg-white shadow-2xl flex flex-col overflow-hidden anim-slide-in">
        {/* Header */}
        <div className="flex items-start gap-3 p-5 border-b border-slate-200">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-0.5 rounded-full border ${cfg.badge}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
                {cfg.label}
              </span>
              <span className={`inline-flex text-xs font-semibold px-2.5 py-0.5 rounded-full border ${priCfg.cls}`}>
                {priCfg.label}
              </span>
              <span className="text-xs text-slate-400 capitalize">{idea.category}</span>
            </div>
            <h2 className="font-bold text-slate-900 text-lg leading-snug">{idea.title}</h2>
            <p className="text-xs text-slate-400 mt-1">Created {formatDate(idea.created_at)}</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-slate-100 hover:bg-slate-200 text-slate-500 flex items-center justify-center shrink-0 transition-all">
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {idea.summary && (
            <div>
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Summary</p>
              <p className="text-sm text-slate-700 leading-relaxed">{idea.summary}</p>
            </div>
          )}

          {idea.action_steps && idea.action_steps.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Action Steps</p>
              <ol className="space-y-1.5">
                {idea.action_steps.map((step, i) => (
                  <li key={i} className="flex gap-2.5 text-sm text-slate-700">
                    <span className="w-5 h-5 rounded-full bg-[#0E90C8]/10 text-[#0E90C8] text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">{i + 1}</span>
                    <span className="leading-relaxed">{step}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {/* Meta */}
          <div className="grid grid-cols-2 gap-3">
            {idea.due_date && (
              <div className="bg-slate-50 rounded-xl p-3 border border-slate-200">
                <p className="text-xs text-slate-400 mb-0.5">Due Date</p>
                <p className="text-sm font-medium text-slate-700">{formatDate(idea.due_date)}</p>
              </div>
            )}
            <div className="bg-slate-50 rounded-xl p-3 border border-slate-200">
              <p className="text-xs text-slate-400 mb-0.5">Reminder Freq.</p>
              <p className="text-sm font-medium text-slate-700">Every {idea.reminder_frequency_hours}h</p>
            </div>
            {idea.next_reminder_at && !idea.reminders_paused && (
              <div className="bg-slate-50 rounded-xl p-3 border border-slate-200">
                <p className="text-xs text-slate-400 mb-0.5">Next Reminder</p>
                <p className="text-sm font-medium text-slate-700">{formatDateTime(idea.next_reminder_at)}</p>
              </div>
            )}
            <div className="bg-slate-50 rounded-xl p-3 border border-slate-200">
              <p className="text-xs text-slate-400 mb-0.5">Reminders Sent</p>
              <p className="text-sm font-medium text-slate-700">{idea.reminder_count}</p>
            </div>
          </div>

          {/* Research */}
          {idea.research_results && (
            <div>
              <button
                onClick={() => setResearchOpen(v => !v)}
                className="flex items-center gap-2 text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2 hover:text-slate-600 transition-colors"
              >
                <svg className={`w-3.5 h-3.5 transition-transform ${researchOpen ? "rotate-90" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="m9 18 6-6-6-6" /></svg>
                Research Results
              </button>
              {researchOpen && (
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">
                  {idea.research_results}
                </div>
              )}
            </div>
          )}

          {/* Timeline */}
          {loading && <div className="text-center text-sm text-slate-400 py-4">Loading history...</div>}
          {detail && detail.idea_updates.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">Timeline</p>
              <div className="space-y-2">
                {detail.idea_updates.map(u => (
                  <div key={u.id} className="flex gap-2.5 text-sm">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#0E90C8] mt-1.5 shrink-0" />
                    <div className="flex-1">
                      <span className="text-slate-700">{u.content}</span>
                      <span className="text-xs text-slate-400 ml-2">{timeAgo(u.created_at)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Slack messages */}
          {detail && detail.companion_messages.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">Slack Thread</p>
              <div className="space-y-2">
                {detail.companion_messages.map(m => (
                  <div key={m.id} className={`flex gap-2 ${m.role === "user" ? "flex-row-reverse" : ""}`}>
                    <div className={`max-w-[80%] px-3 py-2 rounded-2xl text-sm leading-relaxed ${
                      m.role === "user"
                        ? "bg-[#0E90C8] text-white rounded-tr-sm"
                        : "bg-slate-100 text-slate-700 border border-slate-200 rounded-tl-sm"
                    }`}>
                      {m.content}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="p-4 border-t border-slate-200 bg-slate-50">
          {isOpen && (
            <div className="flex gap-2 flex-wrap">
              <button disabled={!!working} onClick={() => handleStatus("completed")} className="flex-1 text-sm font-semibold py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white transition-all disabled:opacity-50 active:scale-[0.98]">
                {working === "completed" ? "..." : "Mark Done"}
              </button>
              <button disabled={!!working} onClick={() => handleStatus("in_progress")} className="flex-1 text-sm font-medium py-2 rounded-xl bg-amber-100 border border-amber-300 hover:bg-amber-200 text-amber-700 transition-all disabled:opacity-50 active:scale-[0.98]">
                {working === "in_progress" ? "..." : "In Progress"}
              </button>
              <button disabled={!!working} onClick={() => handleStatus("parked")} className="text-sm font-medium py-2 px-3 rounded-xl bg-slate-100 border border-slate-200 hover:bg-slate-200 text-slate-600 transition-all disabled:opacity-50 active:scale-[0.98]">
                {working === "parked" ? "..." : "Park"}
              </button>
              <button disabled={!!working} onClick={() => handleStatus("abandoned")} className="text-sm font-medium py-2 px-3 rounded-xl bg-rose-50 border border-rose-200 hover:bg-rose-100 text-rose-600 transition-all disabled:opacity-50 active:scale-[0.98]">
                {working === "abandoned" ? "..." : "Abandon"}
              </button>
            </div>
          )}
          {isClosed && (
            <button disabled={!!working} onClick={() => handleStatus("active")} className="w-full text-sm font-medium py-2 rounded-xl bg-[#0E90C8]/10 border border-[#0E90C8]/30 hover:bg-[#0E90C8]/20 text-[#0E90C8] transition-all disabled:opacity-50 active:scale-[0.98]">
              {working === "active" ? "..." : "Reopen"}
            </button>
          )}
        </div>
      </div>

      <style jsx>{`
        .anim-slide-in { animation: slideIn 0.2s ease-out; }
        @keyframes slideIn { from { transform: translateX(100%); } to { transform: translateX(0); } }
      `}</style>
    </div>
  );
}

// ── Main Dashboard ────────────────────────────────────────────────────────────

export default function DashboardClient({ initialIdeas, initialTeamTasks, userEmail }: {
  initialIdeas: Idea[];
  initialTeamTasks: TeamTask[];
  userEmail?: string | null;
}) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<"ideas" | "team">("ideas");
  const [ideas, setIdeas] = useState<Idea[]>(initialIdeas);
  const [selectedIdea, setSelectedIdea] = useState<Idea | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [priorityFilter, setPriorityFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(new Date());
  const [signingOut, setSigningOut] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshIdeas = useCallback(async () => {
    setRefreshing(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (categoryFilter !== "all") params.set("category", categoryFilter);
      if (search) params.set("search", search);
      const res = await fetch(`/api/companion/ideas?${params.toString()}`, { cache: "no-store" });
      if (res.ok) {
        const { ideas: fresh } = await res.json();
        setIdeas(fresh);
        setLastRefresh(new Date());
      }
    } finally {
      setRefreshing(false);
    }
  }, [statusFilter, categoryFilter, search]);

  useEffect(() => {
    timerRef.current = setInterval(() => refreshIdeas(), 30_000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [refreshIdeas]);

  async function handleStatusChange(id: string, status: IdeaStatus) {
    await fetch(`/api/companion/ideas/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    });
    await refreshIdeas();
  }

  async function signOut() {
    setSigningOut(true);
    try {
      const supabase = createSupabaseBrowser();
      await supabase.auth.signOut();
      router.push("/login");
      router.refresh();
    } catch { setSigningOut(false); }
  }

  // Stats
  const total = ideas.length;
  const activeCount = ideas.filter(i => i.status === "active" || i.status === "in_progress").length;
  const doneWeek = doneThisWeek(ideas);
  const highPri = ideas.filter(i => (i.priority === "high" || i.priority === "critical") && (i.status === "active" || i.status === "in_progress")).length;

  // Filter
  const visibleIdeas = ideas.filter(idea => {
    if (statusFilter !== "all" && idea.status !== statusFilter) return false;
    if (categoryFilter !== "all" && idea.category !== categoryFilter) return false;
    if (priorityFilter !== "all" && idea.priority !== priorityFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return (
        idea.title.toLowerCase().includes(q) ||
        (idea.summary ?? "").toLowerCase().includes(q) ||
        idea.raw_input.toLowerCase().includes(q)
      );
    }
    return true;
  });

  return (
    <main className="min-h-screen text-slate-900" style={{ background: "radial-gradient(ellipse at top, #0d1b2e 0%, #030A18 60%)" }}>
      {selectedIdea && (
        <IdeaPanel
          idea={selectedIdea}
          onClose={() => setSelectedIdea(null)}
          onStatusChange={handleStatusChange}
        />
      )}

      <div className="max-w-6xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-8 gap-4 flex-wrap">
          <div>
            <p className="text-[#0E90C8] text-xs font-bold tracking-[0.25em] uppercase mb-1">OperationAMZ</p>
            <h1 className="text-3xl font-bold text-white tracking-tight">Executive AI</h1>
            <p className="text-white/40 text-xs mt-1">
              Updated {timeAgo(lastRefresh.toISOString())}
              {userEmail && <span className="hidden sm:inline"> · {userEmail}</span>}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <a
              href="/voice"
              className="inline-flex items-center gap-2 bg-[#0E90C8]/20 border border-[#0E90C8]/40 hover:bg-[#0E90C8]/30 text-[#0E90C8] font-medium text-sm px-4 py-2.5 rounded-xl transition-all"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3M8 23h8"/></svg>
              Voice
            </a>
            <button
              onClick={() => refreshIdeas()}
              disabled={refreshing}
              className="inline-flex items-center gap-2 bg-white/10 border border-white/20 hover:bg-white/20 text-white font-medium text-sm px-4 py-2.5 rounded-xl transition-all disabled:opacity-60"
            >
              <svg className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></svg>
              {refreshing ? "Refreshing..." : "Refresh"}
            </button>
            <button
              onClick={signOut}
              disabled={signingOut}
              className="inline-flex items-center gap-2 bg-white/10 border border-white/20 hover:bg-rose-500/20 hover:border-rose-500/40 text-white/70 hover:text-rose-400 font-medium text-sm px-3.5 py-2.5 rounded-xl transition-all disabled:opacity-60"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></svg>
              {signingOut ? "..." : "Sign out"}
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mb-6 bg-white/5 rounded-xl p-1 w-fit border border-white/10">
          {(["ideas", "team"] as const).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-5 py-2 rounded-lg text-sm font-semibold transition-all ${
                activeTab === tab
                  ? "bg-[#0E90C8] text-white shadow-md"
                  : "text-white/50 hover:text-white/80"
              }`}
            >
              {tab === "ideas" ? "Personal Ideas" : "Team Tasks"}
            </button>
          ))}
        </div>

        {activeTab === "ideas" && (
          <>
            {/* Stats */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
              {[
                { label: "Total Ideas",   value: total,       color: "text-white" },
                { label: "Active",        value: activeCount, color: "text-[#0E90C8]" },
                { label: "Done This Week",value: doneWeek,    color: "text-emerald-400" },
                { label: "High Priority", value: highPri,     color: "text-orange-400" },
              ].map(s => (
                <div key={s.label} className="bg-white/5 border border-white/10 rounded-2xl p-4 text-center">
                  <p className="text-white/40 text-xs mb-1 font-medium">{s.label}</p>
                  <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
                </div>
              ))}
            </div>

            {/* Filters */}
            <div className="flex flex-wrap gap-2 mb-4">
              <select
                value={statusFilter}
                onChange={e => setStatusFilter(e.target.value)}
                className={`${INPUT_CLS} bg-white/5 border-white/20 text-white/80`}
              >
                <option value="all">All Status</option>
                <option value="active">Active</option>
                <option value="in_progress">In Progress</option>
                <option value="completed">Completed</option>
                <option value="parked">Parked</option>
                <option value="abandoned">Abandoned</option>
              </select>
              <select
                value={categoryFilter}
                onChange={e => setCategoryFilter(e.target.value)}
                className={`${INPUT_CLS} bg-white/5 border-white/20 text-white/80`}
              >
                <option value="all">All Categories</option>
                <option value="business">Business</option>
                <option value="product">Product</option>
                <option value="personal">Personal</option>
                <option value="research">Research</option>
                <option value="strategy">Strategy</option>
                <option value="other">Other</option>
              </select>
              <select
                value={priorityFilter}
                onChange={e => setPriorityFilter(e.target.value)}
                className={`${INPUT_CLS} bg-white/5 border-white/20 text-white/80`}
              >
                <option value="all">All Priorities</option>
                <option value="critical">Critical</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search ideas..."
                className={`${INPUT_CLS} bg-white/5 border-white/20 text-white placeholder-white/30 flex-1 min-w-[160px]`}
              />
            </div>

            {/* Ideas table */}
            <div className="bg-white/5 border border-white/10 rounded-2xl overflow-hidden">
              {visibleIdeas.length === 0 ? (
                <div className="text-center text-white/30 py-16 text-sm">
                  {ideas.length === 0
                    ? "No ideas yet — send a message to Jarvis in Slack to capture your first idea."
                    : "No ideas match the current filters."}
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-white/10">
                        <th className="text-left px-4 py-3 text-white/40 font-medium text-xs uppercase tracking-wide">Idea</th>
                        <th className="text-left px-4 py-3 text-white/40 font-medium text-xs uppercase tracking-wide hidden sm:table-cell">Category</th>
                        <th className="text-left px-4 py-3 text-white/40 font-medium text-xs uppercase tracking-wide hidden md:table-cell">Priority</th>
                        <th className="text-left px-4 py-3 text-white/40 font-medium text-xs uppercase tracking-wide">Status</th>
                        <th className="text-left px-4 py-3 text-white/40 font-medium text-xs uppercase tracking-wide hidden lg:table-cell">Next Reminder</th>
                        <th className="text-left px-4 py-3 text-white/40 font-medium text-xs uppercase tracking-wide hidden xl:table-cell">Created</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleIdeas.map(idea => {
                        const cfg = IDEA_STATUS[idea.status] ?? IDEA_STATUS.active;
                        const priCfg = PRIORITY[idea.priority] ?? PRIORITY.medium;
                        const nextReminder = idea.next_reminder_at && !idea.reminders_paused
                          ? formatDateTime(idea.next_reminder_at)
                          : idea.reminders_paused ? "Paused" : "—";
                        return (
                          <tr
                            key={idea.id}
                            onClick={() => setSelectedIdea(idea)}
                            className="border-b border-white/5 hover:bg-white/5 cursor-pointer transition-colors"
                          >
                            <td className="px-4 py-3.5">
                              <div className="flex items-start gap-2.5">
                                <span className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${cfg.dot}`} />
                                <span className="text-white font-medium leading-snug line-clamp-2">{idea.title}</span>
                              </div>
                            </td>
                            <td className="px-4 py-3.5 hidden sm:table-cell">
                              <span className="text-white/50 capitalize text-xs">{idea.category}</span>
                            </td>
                            <td className="px-4 py-3.5 hidden md:table-cell">
                              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${priCfg.cls}`}>{priCfg.label}</span>
                            </td>
                            <td className="px-4 py-3.5">
                              <span className={`text-xs font-semibold px-2.5 py-0.5 rounded-full border ${cfg.badge}`}>{cfg.label}</span>
                            </td>
                            <td className="px-4 py-3.5 hidden lg:table-cell">
                              <span className="text-white/40 text-xs">{nextReminder}</span>
                            </td>
                            <td className="px-4 py-3.5 hidden xl:table-cell">
                              <span className="text-white/40 text-xs">{formatDate(idea.created_at)}</span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}

        {activeTab === "team" && (
          <>
            <div className="mb-4 flex items-center justify-between">
              <p className="text-white/50 text-sm">Read-only view of team tasks.</p>
              <a href="https://fireside-trade.vercel.app/dashboard" target="_blank" rel="noopener noreferrer" className="text-[#0E90C8] text-xs hover:underline">
                Open full team dashboard →
              </a>
            </div>
            <div className="bg-white/5 border border-white/10 rounded-2xl overflow-hidden">
              {initialTeamTasks.length === 0 ? (
                <div className="text-center text-white/30 py-16 text-sm">No team tasks found.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-white/10">
                        <th className="text-left px-4 py-3 text-white/40 font-medium text-xs uppercase tracking-wide">Task</th>
                        <th className="text-left px-4 py-3 text-white/40 font-medium text-xs uppercase tracking-wide hidden sm:table-cell">Assignee</th>
                        <th className="text-left px-4 py-3 text-white/40 font-medium text-xs uppercase tracking-wide">Status</th>
                        <th className="text-left px-4 py-3 text-white/40 font-medium text-xs uppercase tracking-wide hidden md:table-cell">Follow-ups</th>
                        <th className="text-left px-4 py-3 text-white/40 font-medium text-xs uppercase tracking-wide hidden lg:table-cell">Created</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(initialTeamTasks as TeamTask[]).map(task => {
                        const statusCfg = TEAM_STATUS[task.status] ?? TEAM_STATUS.active;
                        return (
                          <tr key={task.id} className="border-b border-white/5">
                            <td className="px-4 py-3.5">
                              <div className="flex items-start gap-2.5">
                                <span className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${statusCfg.dot}`} />
                                <span className="text-white/80 leading-snug line-clamp-2">{task.task_text}</span>
                              </div>
                            </td>
                            <td className="px-4 py-3.5 hidden sm:table-cell">
                              <span className="text-white/50 text-xs">{task.assigned_to_name}</span>
                            </td>
                            <td className="px-4 py-3.5">
                              <span className="text-white/60 text-xs">{statusCfg.label}</span>
                            </td>
                            <td className="px-4 py-3.5 hidden md:table-cell">
                              <span className="text-white/40 text-xs">{task.followup_count}/{task.max_followups}</span>
                            </td>
                            <td className="px-4 py-3.5 hidden lg:table-cell">
                              <span className="text-white/40 text-xs">{formatDate(task.created_at)}</span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </main>
  );
}
