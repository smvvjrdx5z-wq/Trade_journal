-- Trade Journal schema
-- Mirrors the six Notion databases of the MT5 -> Notion bridge:
-- Accounts, Trades, Daily Journal, Playbooks, Tags, Performance.
-- Performance is not materialised here — the app computes it on read from
-- the trades table, so it can never go stale.
--
-- Apply with:  supabase db push   (or paste into the SQL editor)

-- ===========================================================================
-- Settings (one row per user, created automatically on signup)
-- ===========================================================================
create table public.user_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  timezone text not null default 'UTC',
  -- Assumed risk when a trade carried no stop loss, as a fraction of balance.
  default_risk_pct numeric not null default 0.01,
  -- Net P&L within +/- this counts as breakeven rather than a win or loss.
  breakeven_threshold numeric not null default 0.5,
  -- Performance scopes with fewer trades than this get a sample warning.
  min_sample_size integer not null default 20,
  -- Bearer token the MT5 bridge presents to POST /api/ingest.
  ingest_token uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now()
);

alter table public.user_settings enable row level security;

create policy "own settings" on public.user_settings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ===========================================================================
-- Accounts
-- ===========================================================================
create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  login bigint,
  name text not null,
  broker text not null default '',
  server text not null default '',
  currency text not null default 'USD',
  account_type text not null default 'Live' check (account_type in ('Live', 'Demo')),
  starting_balance numeric not null default 0,
  current_balance numeric not null default 0,
  current_equity numeric not null default 0,
  active boolean not null default true,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, login)
);

alter table public.accounts enable row level security;

create policy "own accounts" on public.accounts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ===========================================================================
-- Playbooks
-- ===========================================================================
create table public.playbooks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  description text not null default '',
  rules text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

alter table public.playbooks enable row level security;

create policy "own playbooks" on public.playbooks
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ===========================================================================
-- Tags
-- ===========================================================================
create table public.tags (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  category text not null default 'Setup'
    check (category in ('Setup', 'Mistake', 'Emotion', 'Market Condition', 'Management')),
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

alter table public.tags enable row level security;

create policy "own tags" on public.tags
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ===========================================================================
-- Trades — one row per round-turn position
-- ===========================================================================
create table public.trades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  account_id uuid references public.accounts (id) on delete set null,

  -- Identity. position_id is the MT5 idempotency key; null for manual entries.
  position_id bigint,
  symbol text not null,
  direction text not null check (direction in ('Long', 'Short')),
  status text not null default 'Closed',

  -- Execution (machine-owned; refreshed on re-sync)
  volume numeric not null default 0,
  open_time timestamptz not null,
  close_time timestamptz not null,
  entry_price numeric not null default 0,
  exit_price numeric not null default 0,
  stop_loss numeric,
  take_profit numeric,
  gross_pl numeric not null default 0,
  commission numeric not null default 0,
  swap numeric not null default 0,
  fee numeric not null default 0,
  net_pl numeric not null default 0,
  mae numeric,
  mfe numeric,
  tick_size numeric,
  tick_value numeric,
  digits integer not null default 5,
  magic bigint not null default 0,
  mt5_comment text not null default '',
  screenshot_path text,

  -- Derived at write time (see lib/trade-math.ts)
  outcome text not null default 'Breakeven' check (outcome in ('Win', 'Loss', 'Breakeven')),
  session text not null default 'Off Hours',
  trade_date date not null,
  day_of_week text not null default 'Monday',
  hour integer not null default 0,
  duration_minutes numeric not null default 0,
  risk_amount numeric,
  risk_is_estimated boolean not null default false,
  planned_r numeric,
  realized_r numeric,
  return_pct numeric,

  -- Hand-written journal columns. The ingest endpoint never touches these,
  -- exactly as the Notion bridge never overwrites them on update.
  playbook_id uuid references public.playbooks (id) on delete set null,
  setup_grade text check (setup_grade in ('A', 'B', 'C', 'D', 'F')),
  execution_grade text check (execution_grade in ('A', 'B', 'C', 'D', 'F')),
  followed_plan boolean,
  confidence integer check (confidence between 1 and 5),
  entry_reason text not null default '',
  exit_reason text not null default '',
  lessons text not null default '',

  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (user_id, position_id)
);

create index trades_user_close_time on public.trades (user_id, close_time);
create index trades_user_trade_date on public.trades (user_id, trade_date);

alter table public.trades enable row level security;

create policy "own trades" on public.trades
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ===========================================================================
-- Trade <-> Tag join
-- ===========================================================================
create table public.trade_tags (
  trade_id uuid not null references public.trades (id) on delete cascade,
  tag_id uuid not null references public.tags (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  primary key (trade_id, tag_id)
);

alter table public.trade_tags enable row level security;

create policy "own trade tags" on public.trade_tags
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ===========================================================================
-- Daily journal — one page per trading day
-- ===========================================================================
create table public.daily_journal (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  journal_date date not null,

  -- Pre-market plan
  checked_calendar boolean not null default false,
  marked_levels boolean not null default false,
  chose_playbooks boolean not null default false,
  set_loss_limit boolean not null default false,
  bias text not null default '',

  -- Post-market review
  went_well text not null default '',
  went_badly text not null default '',
  do_differently text not null default '',

  -- Rule check
  all_from_playbook boolean not null default false,
  risk_respected boolean not null default false,
  stopped_at_limit boolean not null default false,
  no_revenge boolean not null default false,

  reviewed boolean not null default false,
  created_at timestamptz not null default now(),
  unique (user_id, journal_date)
);

alter table public.daily_journal enable row level security;

create policy "own daily journal" on public.daily_journal
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ===========================================================================
-- Screenshot storage (private bucket; files live under <user_id>/...)
-- ===========================================================================
insert into storage.buckets (id, name, public)
values ('screenshots', 'screenshots', false)
on conflict (id) do nothing;

create policy "own screenshot objects select" on storage.objects
  for select using (bucket_id = 'screenshots' and auth.uid()::text = (storage.foldername(name))[1]);
create policy "own screenshot objects insert" on storage.objects
  for insert with check (bucket_id = 'screenshots' and auth.uid()::text = (storage.foldername(name))[1]);
create policy "own screenshot objects update" on storage.objects
  for update using (bucket_id = 'screenshots' and auth.uid()::text = (storage.foldername(name))[1]);
create policy "own screenshot objects delete" on storage.objects
  for delete using (bucket_id = 'screenshots' and auth.uid()::text = (storage.foldername(name))[1]);

-- ===========================================================================
-- Signup bootstrap: settings row + the 45 seed tags
-- (setup / mistake / emotion / market condition / management)
-- ===========================================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_settings (user_id) values (new.id);

  insert into public.tags (user_id, name, category)
  values
    (new.id, 'Breakout', 'Setup'),
    (new.id, 'Breakout Retest', 'Setup'),
    (new.id, 'Pullback', 'Setup'),
    (new.id, 'Reversal', 'Setup'),
    (new.id, 'Trend Continuation', 'Setup'),
    (new.id, 'Range Fade', 'Setup'),
    (new.id, 'Liquidity Sweep', 'Setup'),
    (new.id, 'News Momentum', 'Setup'),
    (new.id, 'Gap Fill', 'Setup'),

    (new.id, 'Chased Entry', 'Mistake'),
    (new.id, 'Late Entry', 'Mistake'),
    (new.id, 'Moved Stop', 'Mistake'),
    (new.id, 'No Stop Loss', 'Mistake'),
    (new.id, 'Oversized', 'Mistake'),
    (new.id, 'Averaged a Loser', 'Mistake'),
    (new.id, 'Cut Winner Early', 'Mistake'),
    (new.id, 'Revenge Trade', 'Mistake'),
    (new.id, 'Ignored the Plan', 'Mistake'),

    (new.id, 'Calm', 'Emotion'),
    (new.id, 'Confident', 'Emotion'),
    (new.id, 'FOMO', 'Emotion'),
    (new.id, 'Fear', 'Emotion'),
    (new.id, 'Greed', 'Emotion'),
    (new.id, 'Impatient', 'Emotion'),
    (new.id, 'Hesitant', 'Emotion'),
    (new.id, 'Tilted', 'Emotion'),
    (new.id, 'Bored', 'Emotion'),

    (new.id, 'Trending', 'Market Condition'),
    (new.id, 'Ranging', 'Market Condition'),
    (new.id, 'Choppy', 'Market Condition'),
    (new.id, 'High Volatility', 'Market Condition'),
    (new.id, 'Low Volatility', 'Market Condition'),
    (new.id, 'News Driven', 'Market Condition'),
    (new.id, 'Illiquid', 'Market Condition'),
    (new.id, 'Risk-On', 'Market Condition'),
    (new.id, 'Risk-Off', 'Market Condition'),

    (new.id, 'Full Take Profit', 'Management'),
    (new.id, 'Partial Profits', 'Management'),
    (new.id, 'Trailed Stop', 'Management'),
    (new.id, 'Moved to Breakeven', 'Management'),
    (new.id, 'Stopped Out', 'Management'),
    (new.id, 'Manual Exit', 'Management'),
    (new.id, 'Time-Based Exit', 'Management'),
    (new.id, 'Scaled In', 'Management'),
    (new.id, 'Held Through News', 'Management');

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
