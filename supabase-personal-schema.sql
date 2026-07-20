-- ═══════════════════════════════════════════════════════════════
-- Brandon Personal AI Companion — Supabase Schema
-- Run this in your PERSONAL Supabase project SQL editor
-- (NOT the team database)
-- ═══════════════════════════════════════════════════════════════

-- ── 1. IDEAS ────────────────────────────────────────────────────

create table if not exists ideas (
  id                      uuid primary key default gen_random_uuid(),
  title                   text not null,
  raw_input               text not null,
  summary                 text,
  action_steps            text[],
  category                text not null default 'General',
  priority                text not null default 'Medium',
  status                  text not null default 'Active',

  -- Slack context
  channel_id              text,
  message_ts              text,
  thread_ts               text,

  -- Voice
  voice_transcription     text,
  audio_file_url          text,

  -- Reminders
  reminder_frequency_hours integer not null default 24,
  next_reminder_at         timestamptz,
  last_reminder_at         timestamptz,
  reminder_count           integer not null default 0,
  reminders_paused         boolean not null default false,
  pause_until              timestamptz,

  -- Dates
  due_date                timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  completed_at            timestamptz,
  abandoned_at            timestamptz,

  -- Research
  research_results        text,
  research_query          text
);

-- Auto-update updated_at
create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger ideas_updated_at
  before update on ideas
  for each row execute function update_updated_at();

-- Index for reminder cron queries
create index if not exists ideas_next_reminder_idx
  on ideas (next_reminder_at)
  where reminders_paused = false
    and status not in ('Done', 'Abandoned', 'Parked');

-- Index for status filtering
create index if not exists ideas_status_idx on ideas (status);


-- ── 2. IDEA UPDATES (timeline / audit log) ──────────────────────

create table if not exists idea_updates (
  id             uuid primary key default gen_random_uuid(),
  idea_id        uuid not null references ideas (id) on delete cascade,
  update_type    text not null,   -- created | status_change | reminder_sent | research_completed | note
  content        text not null,
  sent_to_slack  boolean not null default false,
  created_at     timestamptz not null default now()
);

create index if not exists idea_updates_idea_id_idx on idea_updates (idea_id);


-- ── 3. COMPANION MESSAGES (conversation history) ────────────────

create table if not exists companion_messages (
  id          uuid primary key default gen_random_uuid(),
  role        text not null check (role in ('user', 'assistant')),
  content     text not null,
  channel_id  text,
  thread_ts   text,
  idea_id     uuid references ideas (id) on delete set null,
  tokens_used integer not null default 0,
  created_at  timestamptz not null default now()
);

create index if not exists companion_messages_thread_idx on companion_messages (thread_ts);
create index if not exists companion_messages_created_idx on companion_messages (created_at desc);


-- ── 4. RESEARCH CACHE ────────────────────────────────────────────

create table if not exists research_cache (
  id          uuid primary key default gen_random_uuid(),
  query       text not null,
  results     text not null,
  source_urls text[],
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default (now() + interval '7 days')
);

create index if not exists research_cache_query_idx on research_cache (query);
create index if not exists research_cache_expires_idx on research_cache (expires_at);


-- ── ROW LEVEL SECURITY (optional but recommended) ───────────────
-- Enable RLS on all tables so only the service role can access them.
-- The app uses the service role key, so this is transparent.

alter table ideas              enable row level security;
alter table idea_updates       enable row level security;
alter table companion_messages enable row level security;
alter table research_cache     enable row level security;

-- Allow full access for the service role (used by the app)
create policy "service role full access" on ideas
  for all using (true);

create policy "service role full access" on idea_updates
  for all using (true);

create policy "service role full access" on companion_messages
  for all using (true);

create policy "service role full access" on research_cache
  for all using (true);
