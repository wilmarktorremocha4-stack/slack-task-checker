"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowser } from "@/lib/supabase-browser";
import type { TeamTask } from "@/lib/supabase-team";

// ── Types ─────────────────────────────────────────────────────────────────────

type IdeaStatus = "Active" | "In Progress" | "Done" | "Parked" | "Abandoned";
type IdeaPriority = "High" | "Medium" | "Low";

interface Idea {
  id: string;
  title: string;
  summary: string | null;
  raw_input: string;
  status: IdeaStatus;
  category: string;
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

// ── Config ────────────────────────────────────────────────────────────────────

const IDEA_STATUS: Record<IdeaStatus, { label: string; dot: string; badge: string }> = {
  "Active":      { label: "Active",      dot: "bg-emerald-400",  badge: "bg-emerald-900/40 text-emerald-300 border-emerald-700/50" },
  "In Progress": { label: "In Progress", dot: "bg-amber-400",    badge: "bg-amber-900/40 text-amber-300 border-amber-700/50" },
  "Done":        { label: "Done",        dot: "bg-slate-400",    badge: "bg-slate-800 text-slate-400 border-slate-600" },
  "Parked":      { label: "Parked",      dot: "bg-blue-400",     badge: "bg-blue-900/40 text-blue-300 border-blue-700/50" },
  "Abandoned":   { label: "Abandoned",   dot: "bg-rose-500",     badge: "bg-rose-900/40 text-rose-400 border-rose-700/50" },
};

const PRIORITY: Record<IdeaPriority, { label: string; cls: string }> = {
  "Low":    { label: "Low",    cls: "text-slate-400 bg-slate-800 border-slate-600" },
  "Medium": { label: "Medium", cls: "text-sky-300 bg-sky-900/40 border-sky-700/50" },
  "High":   { label: "High",   cls: "text-amber-300 bg-amber-900/40 border-amber-700/50" },
};

const TEAM_STATUS: Record<string, { label: string; dot: string }> = {
  active:             { label: "Active",        dot: "bg-blue-400" },
  revision_requested: { label: "Revision Sent", dot: "bg-orange-400" },
  completed:          { label: "Done",          dot: "bg-emerald-400" },
  cancelled:          { label: "Cancelled",     dot: "bg-slate-500" },
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
  return ideas.filter(i => i.status === "Done" && i.completed_at && new Date(i.completed_at).getTime() > weekAgo).length;
}

// ── Idea Detail Panel ─────────────────────────────────────────────────────────

function IdeaPanel({ idea: initial, onClose, onStatusChange }: {
  idea: Idea;
  onClose: () => void;
  onStatusChange: (id: string, status: IdeaStatus) => Promise<void>;
}) {
  const [detail, setDetail] = useState<IdeaDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [researchOpen, setResearchOpen] = useState(false);
  const [working, setWorking] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/companion/ideas/${initial.id}`)
      .then(r => r.json())
      .then(d => { setDetail(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [initial.id]);

  const idea = detail ?? initial;
  const cfg = IDEA_STATUS[idea.status] ?? IDEA_STATUS["Active"];
  const priCfg = PRIORITY[idea.priority] ?? PRIORITY["Medium"];
  const isOpen = idea.status === "Active" || idea.status === "In Progress";
  const isClosed = idea.status === "Done" || idea.status === "Parked" || idea.status === "Abandoned";

  async function handleStatus(status: IdeaStatus) {
    setWorking(status);
    await onStatusChange(idea.id, status);
    setWorking(null);
    onClose();
  }

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-end">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative h-full w-full max-w-xl bg-[#0d1117] border-l border-white/10 flex flex-col overflow-hidden" style={{ animation: "slideIn 0.2s ease-out" }}>
        {/* Header */}
        <div className="flex items-start gap-3 p-5 border-b border-white/10">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-0.5 rounded-full border ${cfg.badge}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
                {cfg.label}
              </span>
              <span className={`inline-flex text-xs font-semibold px-2.5 py-0.5 rounded-full border ${priCfg.cls}`}>
                {priCfg.label}
              </span>
              <span className="text-xs text-white/30 capitalize">{idea.category}</span>
            </div>
            <h2 className="font-bold text-white text-lg leading-snug">{idea.title}</h2>
            <p className="text-xs text-white/30 mt-1">Created {formatDate(idea.created_at)}</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-white/5 hover:bg-white/10 text-white/50 flex items-center justify-center shrink-0 transition-all">
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {idea.summary && (
            <div>
              <p className="text-xs font-semibold text-white/30 uppercase tracking-wide mb-2">Summary</p>
              <p className="text-sm text-white/70 leading-relaxed">{idea.summary}</p>
            </div>
          )}

          {idea.action_steps && idea.action_steps.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-white/30 uppercase tracking-wide mb-2">Action Steps</p>
              <ol className="space-y-2">
                {idea.action_steps.map((step, i) => (
                  <li key={i} className="flex gap-2.5 text-sm text-white/70">
                    <span className="w-5 h-5 rounded-full bg-sky-500/20 text-sky-400 text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">{i + 1}</span>
                    <span className="leading-relaxed">{step}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {/* Meta grid */}
          <div className="grid grid-cols-2 gap-2">
            {idea.due_date && (
              <div className="bg-white/5 rounded-xl p-3 border border-white/10">
                <p className="text-xs text-white/30 mb-0.5">Due Date</p>
                <p className="text-sm font-medium text-white/80">{formatDate(idea.due_date)}</p>
              </div>
            )}
            <div className="bg-white/5 rounded-xl p-3 border border-white/10">
              <p className="text-xs text-white/30 mb-0.5">Reminder Freq.</p>
              <p className="text-sm font-medium text-white/80">Every {idea.reminder_frequency_hours}h</p>
            </div>
            {idea.next_reminder_at && !idea.reminders_paused && (
              <div className="bg-white/5 rounded-xl p-3 border border-white/10">
                <p className="text-xs text-white/30 mb-0.5">Next Reminder</p>
                <p className="text-sm font-medium text-white/80">{formatDateTime(idea.next_reminder_at)}</p>
              </div>
            )}
            <div className="bg-white/5 rounded-xl p-3 border border-white/10">
              <p className="text-xs text-white/30 mb-0.5">Reminders Sent</p>
              <p className="text-sm font-medium text-white/80">{idea.reminder_count}</p>
            </div>
          </div>

          {/* Research */}
          {idea.research_results && (
            <div>
              <button onClick={() => setResearchOpen(v => !v)} className="flex items-center gap-2 text-xs font-semibold text-white/30 uppercase tracking-wide mb-2 hover:text-white/50 transition-colors">
                <svg className={`w-3.5 h-3.5 transition-transform ${researchOpen ? "rotate-90" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="m9 18 6-6-6-6" /></svg>
                Research Results
              </button>
              {researchOpen && (
                <div className="bg-white/5 border border-white/10 rounded-xl p-4 text-sm text-white/60 leading-relaxed whitespace-pre-wrap">
                  {idea.research_results}
                </div>
              )}
            </div>
          )}

          {/* Timeline */}
          {loading && <p className="text-center text-sm text-white/30 py-4">Loading history...</p>}
          {detail && detail.idea_updates.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-white/30 uppercase tracking-wide mb-3">Timeline</p>
              <div className="space-y-2">
                {detail.idea_updates.map(u => (
                  <div key={u.id} className="flex gap-2.5 text-sm">
                    <span className="w-1.5 h-1.5 rounded-full bg-sky-500 mt-1.5 shrink-0" />
                    <div className="flex-1">
                      <span className="text-white/60">{u.content}</span>
                      <span className="text-xs text-white/25 ml-2">{timeAgo(u.created_at)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Slack thread */}
          {detail && detail.companion_messages.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-white/30 uppercase tracking-wide mb-3">Slack Thread</p>
              <div className="space-y-2">
                {detail.companion_messages.map(m => (
                  <div key={m.id} className={`flex gap-2 ${m.role === "user" ? "flex-row-reverse" : ""}`}>
                    <div className={`max-w-[80%] px-3 py-2 rounded-2xl text-sm leading-relaxed ${
                      m.role === "user"
                        ? "bg-sky-600 text-white rounded-tr-sm"
                        : "bg-white/10 text-white/70 border border-white/10 rounded-tl-sm"
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
        <div className="p-4 border-t border-white/10 bg-black/20">
          {isOpen && (
            <div className="flex gap-2 flex-wrap">
              <button disabled={!!working} onClick={() => handleStatus("Done")} className="flex-1 text-sm font-semibold py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white transition-all disabled:opacity-50 active:scale-[0.98]">
                {working === "Done" ? "..." : "Mark Done"}
              </button>
              <button disabled={!!working} onClick={() => handleStatus("In Progress")} className="flex-1 text-sm font-medium py-2 rounded-xl bg-amber-500/20 border border-amber-500/40 hover:bg-amber-500/30 text-amber-300 transition-all disabled:opacity-50 active:scale-[0.98]">
                {working === "In Progress" ? "..." : "In Progress"}
              </button>
              <button disabled={!!working} onClick={() => handleStatus("Parked")} className="text-sm font-medium py-2 px-3 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 text-white/50 transition-all disabled:opacity-50 active:scale-[0.98]">
                {working === "Parked" ? "..." : "Park"}
              </button>
              <button disabled={!!working} onClick={() => handleStatus("Abandoned")} className="text-sm font-medium py-2 px-3 rounded-xl bg-rose-500/10 border border-rose-500/20 hover:bg-rose-500/20 text-rose-400 transition-all disabled:opacity-50 active:scale-[0.98]">
                {working === "Abandoned" ? "..." : "Abandon"}
              </button>
            </div>
          )}
          {isClosed && (
            <button disabled={!!working} onClick={() => handleStatus("Active")} className="w-full text-sm font-medium py-2 rounded-xl bg-sky-500/10 border border-sky-500/20 hover:bg-sky-500/20 text-sky-400 transition-all disabled:opacity-50 active:scale-[0.98]">
              {working === "Active" ? "..." : "Reopen"}
            </button>
          )}
        </div>
      </div>

      <style jsx>{`
        @keyframes slideIn { from { transform: translateX(100%); } to { transform: translateX(0); } }
      `}</style>
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function CompanionClient({ initialIdeas, initialTeamTasks, userEmail }: {
  initialIdeas: Idea[];
  initialTeamTasks: TeamTask[];
  userEmail?: string | null;
}) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<"ideas" | "team">("ideas");
  const [ideas, setIdeas] = useState<Idea[]>(initialIdeas);
  const [selected, setSelected] = useState<Idea | null>(null);
  const [statusFilter, setStatusFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [priorityFilter, setPriorityFilter] = useState("all");
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
    } finally { setRefreshing(false); }
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
  const activeCount = ideas.filter(i => i.status === "Active" || i.status === "In Progress").length;
  const doneWeek = doneThisWeek(ideas);
  const highPri = ideas.filter(i => i.priority === "High" && (i.status === "Active" || i.status === "In Progress")).length;

  // Filter
  const visible = ideas.filter(idea => {
    if (statusFilter !== "all" && idea.status !== statusFilter) return false;
    if (categoryFilter !== "all" && idea.category !== categoryFilter) return false;
    if (priorityFilter !== "all" && idea.priority !== priorityFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return idea.title.toLowerCase().includes(q) || (idea.summary ?? "").toLowerCase().includes(q) || idea.raw_input.toLowerCase().includes(q);
    }
    return true;
  });

  const SEL = "bg-sky-500 text-white";
  const UNSEL = "text-white/40 hover:text-white/70";

  return (
    <main className="min-h-screen text-white" style={{ background: "linear-gradient(135deg, #060c1a 0%, #0a1628 40%, #071020 100%)" }}>
      {selected && (
        <IdeaPanel idea={selected} onClose={() => setSelected(null)} onStatusChange={handleStatusChange} />
      )}

      <div className="max-w-6xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-8 gap-4 flex-wrap">
          <div>
            <p className="text-sky-400 text-xs font-bold tracking-[0.3em] uppercase mb-1">Jarvis</p>
            <h1 className="text-3xl font-bold text-white tracking-tight">Personal Dashboard</h1>
            <p className="text-white/25 text-xs mt-1">
              {timeAgo(lastRefresh.toISOString())}
              {userEmail && <span className="hidden sm:inline"> · {userEmail}</span>}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <a href="/voice" className="inline-flex items-center gap-2 bg-sky-500/10 border border-sky-500/30 hover:bg-sky-500/20 text-sky-400 font-medium text-sm px-4 py-2.5 rounded-xl transition-all">
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3M8 23h8"/></svg>
              Voice
            </a>
            <button onClick={() => refreshIdeas()} disabled={refreshing} className="inline-flex items-center gap-2 bg-white/5 border border-white/10 hover:bg-white/10 text-white/60 font-medium text-sm px-4 py-2.5 rounded-xl transition-all disabled:opacity-60">
              <svg className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></svg>
              {refreshing ? "Refreshing..." : "Refresh"}
            </button>
            <button onClick={signOut} disabled={signingOut} className="inline-flex items-center gap-2 bg-white/5 border border-white/10 hover:bg-rose-500/10 hover:border-rose-500/20 text-white/40 hover:text-rose-400 font-medium text-sm px-3.5 py-2.5 rounded-xl transition-all disabled:opacity-60">
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></svg>
              {signingOut ? "..." : "Sign out"}
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mb-6 bg-white/5 rounded-xl p-1 w-fit border border-white/10">
          <button onClick={() => setActiveTab("ideas")} className={`px-5 py-2 rounded-lg text-sm font-semibold transition-all ${activeTab === "ideas" ? SEL : UNSEL}`}>
            Personal Ideas
          </button>
          <button onClick={() => setActiveTab("team")} className={`px-5 py-2 rounded-lg text-sm font-semibold transition-all ${activeTab === "team" ? SEL : UNSEL}`}>
            Team Tasks
          </button>
        </div>

        {activeTab === "ideas" && (
          <>
            {/* Stats */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
              {[
                { label: "Total Ideas",    value: ideas.length, color: "text-white" },
                { label: "Active",         value: activeCount,  color: "text-sky-400" },
                { label: "Done This Week", value: doneWeek,     color: "text-emerald-400" },
                { label: "High Priority",  value: highPri,      color: "text-amber-400" },
              ].map(s => (
                <div key={s.label} className="bg-white/5 border border-white/10 rounded-2xl p-4 text-center">
                  <p className="text-white/30 text-xs mb-1 font-medium">{s.label}</p>
                  <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
                </div>
              ))}
            </div>

            {/* Filters */}
            <div className="flex flex-wrap gap-2 mb-4">
              <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
                className="bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white/70 focus:outline-none focus:border-sky-500/50">
                <option value="all">All Status</option>
                <option value="Active">Active</option>
                <option value="In Progress">In Progress</option>
                <option value="Done">Done</option>
                <option value="Parked">Parked</option>
                <option value="Abandoned">Abandoned</option>
              </select>
              <select value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)}
                className="bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white/70 focus:outline-none focus:border-sky-500/50">
                <option value="all">All Categories</option>
                <option value="Business">Business</option>
                <option value="Product">Product</option>
                <option value="Personal">Personal</option>
                <option value="Research">Research</option>
                <option value="Strategy">Strategy</option>
                <option value="Other">Other</option>
              </select>
              <select value={priorityFilter} onChange={e => setPriorityFilter(e.target.value)}
                className="bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white/70 focus:outline-none focus:border-sky-500/50">
                <option value="all">All Priorities</option>
                <option value="High">High</option>
                <option value="Medium">Medium</option>
                <option value="Low">Low</option>
              </select>
              <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search ideas..."
                className="bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder-white/20 focus:outline-none focus:border-sky-500/50 flex-1 min-w-[160px]" />
            </div>

            {/* Table */}
            <div className="bg-white/3 border border-white/10 rounded-2xl overflow-hidden">
              {visible.length === 0 ? (
                <div className="text-center text-white/20 py-16 text-sm">
                  {ideas.length === 0
                    ? "No ideas yet — send a message to Jarvis in Slack to capture your first idea."
                    : "No ideas match the current filters."}
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-white/10">
                        {["Idea", "Category", "Priority", "Status", "Next Reminder", "Created"].map((h, i) => (
                          <th key={h} className={`text-left px-4 py-3 text-white/25 font-medium text-xs uppercase tracking-wide ${i > 0 ? "hidden sm:table-cell" : ""} ${i > 2 ? "hidden md:table-cell" : ""} ${i > 3 ? "hidden lg:table-cell" : ""}`}>
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map(idea => {
                        const cfg = IDEA_STATUS[idea.status] ?? IDEA_STATUS["Active"];
                        const priCfg = PRIORITY[idea.priority] ?? PRIORITY["Medium"];
                        const nextReminder = idea.next_reminder_at && !idea.reminders_paused
                          ? formatDateTime(idea.next_reminder_at)
                          : idea.reminders_paused ? "Paused" : "—";
                        return (
                          <tr key={idea.id} onClick={() => setSelected(idea)}
                            className="border-b border-white/5 hover:bg-white/5 cursor-pointer transition-colors">
                            <td className="px-4 py-3.5">
                              <div className="flex items-start gap-2.5">
                                <span className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${cfg.dot}`} />
                                <span className="text-white/80 font-medium leading-snug line-clamp-2">{idea.title}</span>
                              </div>
                            </td>
                            <td className="px-4 py-3.5 hidden sm:table-cell">
                              <span className="text-white/35 capitalize text-xs">{idea.category}</span>
                            </td>
                            <td className="px-4 py-3.5 hidden sm:table-cell">
                              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${priCfg.cls}`}>{priCfg.label}</span>
                            </td>
                            <td className="px-4 py-3.5 hidden md:table-cell">
                              <span className={`text-xs font-semibold px-2.5 py-0.5 rounded-full border ${cfg.badge}`}>{cfg.label}</span>
                            </td>
                            <td className="px-4 py-3.5 hidden lg:table-cell">
                              <span className="text-white/25 text-xs">{nextReminder}</span>
                            </td>
                            <td className="px-4 py-3.5 hidden lg:table-cell">
                              <span className="text-white/25 text-xs">{formatDate(idea.created_at)}</span>
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
              <p className="text-white/30 text-sm">Read-only view of team tasks.</p>
              <a href="/dashboard" className="text-sky-400 text-xs hover:underline">Open full team dashboard →</a>
            </div>
            <div className="bg-white/3 border border-white/10 rounded-2xl overflow-hidden">
              {initialTeamTasks.length === 0 ? (
                <div className="text-center text-white/20 py-16 text-sm">No team tasks found.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-white/10">
                        {["Task", "Assignee", "Status", "Follow-ups", "Created"].map((h, i) => (
                          <th key={h} className={`text-left px-4 py-3 text-white/25 font-medium text-xs uppercase tracking-wide ${i > 0 ? "hidden sm:table-cell" : ""} ${i > 2 ? "hidden md:table-cell" : ""}`}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {initialTeamTasks.map(task => {
                        const s = TEAM_STATUS[task.status] ?? TEAM_STATUS.active;
                        return (
                          <tr key={task.id} className="border-b border-white/5">
                            <td className="px-4 py-3.5">
                              <div className="flex items-start gap-2.5">
                                <span className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${s.dot}`} />
                                <span className="text-white/60 leading-snug line-clamp-2">{task.task_text}</span>
                              </div>
                            </td>
                            <td className="px-4 py-3.5 hidden sm:table-cell"><span className="text-white/35 text-xs">{task.assigned_to_name}</span></td>
                            <td className="px-4 py-3.5 hidden sm:table-cell"><span className="text-white/40 text-xs">{s.label}</span></td>
                            <td className="px-4 py-3.5 hidden md:table-cell"><span className="text-white/25 text-xs">{task.followup_count}/{task.max_followups}</span></td>
                            <td className="px-4 py-3.5 hidden md:table-cell"><span className="text-white/25 text-xs">{formatDate(task.created_at)}</span></td>
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
