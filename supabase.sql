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
