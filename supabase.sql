-- Squeek Picks: database setup
-- Run this once in your Supabase project: SQL Editor > New query > paste > Run.
--
-- A "night" is the Squeekchain API's own day: 12:00 UTC on that date
-- until 12:00 UTC the next day. Picks for a night close when it starts.
-- The lock lives here in the database, so nobody can change a pick late
-- by editing the page.

-- The night players can still pick for. The night in progress is the
-- one before it.
create or replace function public.open_night()
returns date
language sql
stable
as $$
  select (((now() at time zone 'utc') - interval '12 hours')::date + 1)
$$;

-- Players: one row per person, keyed by their Supabase sign-in.
create table if not exists public.players (
  id uuid primary key references auth.users (id) on delete cascade,
  nickname text not null check (nickname ~ '^[A-Za-z0-9_.-]{2,20}$'),
  created_at timestamptz not null default now()
);

create unique index if not exists players_nickname_lower_key
  on public.players (lower(nickname));

-- Picks: one ticket per player per night.
--   distance_km  guess for the night's distance, one decimal
--   peak_block   0..7, the 3-hour block of the night (0 = 12:00-15:00 UTC,
--                1 = 15:00-18:00, ... 7 = 09:00-12:00 the next morning)
--   more_blocks  true = more Squeek blocks settle than the night before
create table if not exists public.picks (
  player_id uuid not null references public.players (id) on delete cascade,
  night date not null,
  distance_km numeric(4, 1) not null check (distance_km >= 0 and distance_km <= 60),
  peak_block smallint not null check (peak_block between 0 and 7),
  more_blocks boolean not null,
  updated_at timestamptz not null default now(),
  primary key (player_id, night)
);

create index if not exists picks_night_idx on public.picks (night);

-- The server sets updated_at, never the browser.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

drop trigger if exists picks_touch on public.picks;
create trigger picks_touch
  before insert or update on public.picks
  for each row execute function public.touch_updated_at();

-- Row security: who can see and change what.
alter table public.players enable row level security;
alter table public.picks enable row level security;

drop policy if exists "Everyone sees nicknames" on public.players;
create policy "Everyone sees nicknames"
  on public.players for select
  using (true);

drop policy if exists "Players create their own row" on public.players;
create policy "Players create their own row"
  on public.players for insert to authenticated
  with check (id = auth.uid());

drop policy if exists "Players rename themselves" on public.players;
create policy "Players rename themselves"
  on public.players for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- Picks stay hidden until their night locks, except your own.
drop policy if exists "Picks show once locked" on public.picks;
create policy "Picks show once locked"
  on public.picks for select
  using (night < public.open_night() or player_id = auth.uid());

-- You can only pick for the open night, and only for yourself.
drop policy if exists "Pick the open night" on public.picks;
create policy "Pick the open night"
  on public.picks for insert to authenticated
  with check (player_id = auth.uid() and night = public.open_night());

drop policy if exists "Change picks until lock" on public.picks;
create policy "Change picks until lock"
  on public.picks for update to authenticated
  using (player_id = auth.uid() and night = public.open_night())
  with check (player_id = auth.uid() and night = public.open_night());

-- No delete policies: nobody deletes through the site. You can still
-- remove rows yourself in the Table Editor.

grant select on public.players, public.picks to anon, authenticated;
grant insert, update on public.players, public.picks to authenticated;
grant execute on function public.open_night() to anon, authenticated;

-- ---------- Seasons ----------
-- Added for Season 1. Safe to run again: it only adds what's missing.

-- One market per pick can count twice in a season: 'distance', 'peak' or 'blocks'.
alter table public.picks add column if not exists double_market text
  check (double_market in ('distance', 'peak', 'blocks'));

-- Nobody sees how others picked a night until it starts (the picks policy above), not even
-- as counts: the diary is what players go on. An earlier version had a pick_odds function
-- that showed the counts; this removes it.
drop function if exists public.pick_odds(date);

-- ---------- Live calls ----------
-- In a season, three quick calls a night on one hour of his running each (more or fewer
-- spins than his usual for that hour). A call closes when its hour starts: 21:00, 23:00
-- and 01:00 UTC. Safe to run again.
create or replace function public.call_closes(p_night date, p_call smallint)
returns timestamptz
language sql
immutable
as $$
  select (p_night::timestamp + interval '12 hours'
          + (case p_call when 1 then 9 when 2 then 11 when 3 then 13 end) * interval '1 hour') at time zone 'utc'
$$;

create table if not exists public.call_answers (
  player_id uuid not null references public.players (id) on delete cascade,
  night date not null,
  call_no smallint not null check (call_no between 1 and 3),
  over boolean not null,
  updated_at timestamptz not null default now(),
  primary key (player_id, night, call_no)
);

drop trigger if exists call_answers_touch on public.call_answers;
create trigger call_answers_touch
  before insert or update on public.call_answers
  for each row execute function public.touch_updated_at();

alter table public.call_answers enable row level security;

-- Answers stay hidden until their call closes, except your own.
drop policy if exists "Answers show once the call closes" on public.call_answers;
create policy "Answers show once the call closes"
  on public.call_answers for select
  using (now() >= public.call_closes(night, call_no) or player_id = auth.uid());

-- You answer the running night's calls, for yourself, until each one closes.
drop policy if exists "Answer a call until it closes" on public.call_answers;
create policy "Answer a call until it closes"
  on public.call_answers for insert to authenticated
  with check (player_id = auth.uid() and night = public.open_night() - 1 and now() < public.call_closes(night, call_no));

drop policy if exists "Change an answer until the call closes" on public.call_answers;
create policy "Change an answer until the call closes"
  on public.call_answers for update to authenticated
  using (player_id = auth.uid() and night = public.open_night() - 1 and now() < public.call_closes(night, call_no))
  with check (player_id = auth.uid() and night = public.open_night() - 1 and now() < public.call_closes(night, call_no));

grant select on public.call_answers to anon, authenticated;
grant insert, update on public.call_answers to authenticated;
grant execute on function public.call_closes(date, smallint) to anon, authenticated;

-- Answers stay hidden while a call is open, even as counts.
drop function if exists public.call_odds(date);

-- ---------- Night Cards ----------
-- Where a player's Night Cards go: a wallet, proven with a signature the minting bot checks
-- before it sends anything. Linked wallets are public, like pot tickets. Safe to run again.
create table if not exists public.wallet_links (
  player_id uuid primary key references public.players (id) on delete cascade,
  wallet text not null check (wallet ~ '^0x[0-9a-fA-F]{40}$'),
  message text not null check (length(message) <= 300),
  signature text not null check (signature ~ '^0x[0-9a-fA-F]{130}$'),
  updated_at timestamptz not null default now()
);

-- One wallet, one nickname's cards: the minting bot gives a wallet's cards to the first
-- nickname that proved it with a signature, and ignores the rest. (An earlier version made
-- the database refuse a second link to a wallet. It can't check signatures, so anyone could
-- claim someone else's wallet first and lock them out. This removes that rule.)
drop index if exists public.wallet_links_wallet_key;

drop trigger if exists wallet_links_touch on public.wallet_links;
create trigger wallet_links_touch
  before insert or update on public.wallet_links
  for each row execute function public.touch_updated_at();

alter table public.wallet_links enable row level security;

drop policy if exists "Everyone sees linked wallets" on public.wallet_links;
create policy "Everyone sees linked wallets"
  on public.wallet_links for select
  using (true);

drop policy if exists "Players link their own wallet" on public.wallet_links;
create policy "Players link their own wallet"
  on public.wallet_links for insert to authenticated
  with check (player_id = auth.uid());

drop policy if exists "Players change their own wallet" on public.wallet_links;
create policy "Players change their own wallet"
  on public.wallet_links for update to authenticated
  using (player_id = auth.uid())
  with check (player_id = auth.uid());

grant select on public.wallet_links to anon, authenticated;
grant insert, update on public.wallet_links to authenticated;
