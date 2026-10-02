-- Three-Block Week — database setup
-- Paste this whole file into Supabase → SQL Editor → New query, then click Run. Safe to run once on a new project.

-- 1. Who is on staff. Only these email addresses can see or use the planner.
create table if not exists public.staff (
  email      text primary key,
  is_admin   boolean not null default false,
  added_at   timestamptz not null default now()
);

-- 2. One row per signed-in person (name and photo shown to the rest of staff).
create table if not exists public.profiles (
  id          uuid primary key references auth.users on delete cascade,
  email       text,
  name        text,
  avatar_url  text,
  updated_at  timestamptz not null default now()
);

-- 3. Each person's plan for one day (the three blocks, their types, objectives and tasks).
create table if not exists public.days (
  user_id     uuid not null references auth.users on delete cascade,
  date        date not null,
  data        jsonb not null,
  updated_at  timestamptz not null default now(),
  primary key (user_id, date)
);

-- 4. Each person's weekly priorities (keyed by the Monday that starts the week).
create table if not exists public.weeks (
  user_id     uuid not null references auth.users on delete cascade,
  week_start  date not null,
  data        jsonb not null,
  updated_at  timestamptz not null default now(),
  primary key (user_id, week_start)
);

-- 5. Each person's guardrail settings and standard week.
create table if not exists public.meta (
  user_id     uuid not null references auth.users on delete cascade,
  name        text not null,
  data        jsonb not null,
  updated_at  timestamptz not null default now(),
  primary key (user_id, name)
);

-- Is the signed-in person on the staff list?
create or replace function public.is_staff()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.staff s
    where lower(s.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;
grant execute on function public.is_staff() to authenticated;

-- Row-level security: staff can read everyone's plans; each person can only change their own.
alter table public.staff    enable row level security;
alter table public.profiles enable row level security;
alter table public.days     enable row level security;
alter table public.weeks    enable row level security;
alter table public.meta     enable row level security;

drop policy if exists "staff read list" on public.staff;
create policy "staff read list" on public.staff
  for select to authenticated using (public.is_staff());

drop policy if exists "staff read profiles" on public.profiles;
create policy "staff read profiles" on public.profiles
  for select to authenticated using (public.is_staff());
drop policy if exists "own profile insert" on public.profiles;
create policy "own profile insert" on public.profiles
  for insert to authenticated with check (id = auth.uid() and public.is_staff());
drop policy if exists "own profile update" on public.profiles;
create policy "own profile update" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid() and public.is_staff());

do $$
declare t text;
begin
  foreach t in array array['days','weeks','meta'] loop
    execute format('drop policy if exists "staff read" on public.%I', t);
    execute format('create policy "staff read" on public.%I for select to authenticated using (public.is_staff())', t);
    execute format('drop policy if exists "own insert" on public.%I', t);
    execute format('create policy "own insert" on public.%I for insert to authenticated with check (user_id = auth.uid() and public.is_staff())', t);
    execute format('drop policy if exists "own update" on public.%I', t);
    execute format('create policy "own update" on public.%I for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid() and public.is_staff())', t);
    execute format('drop policy if exists "own delete" on public.%I', t);
    execute format('create policy "own delete" on public.%I for delete to authenticated using (user_id = auth.uid())', t);
  end loop;
end $$;

-- Live updates: when someone changes their week, everyone with the page open sees it.
do $$
declare t text;
begin
  foreach t in array array['days','weeks','meta','profiles'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- Start the staff list with yourself: replace the address below, then run this line.
-- insert into public.staff (email, is_admin) values ('you@example.org', true) on conflict (email) do nothing;

-- 6. Each person's Basecamp connection (encrypted by the site's server; private to that person).
create table if not exists public.basecamp_links (
  user_id     uuid primary key references auth.users on delete cascade,
  blob        text not null,
  account     text,
  updated_at  timestamptz not null default now()
);
alter table public.basecamp_links enable row level security;
drop policy if exists "own link read" on public.basecamp_links;
create policy "own link read" on public.basecamp_links for select to authenticated using (user_id = auth.uid());
drop policy if exists "own link insert" on public.basecamp_links;
create policy "own link insert" on public.basecamp_links for insert to authenticated with check (user_id = auth.uid() and public.is_staff());
drop policy if exists "own link update" on public.basecamp_links;
create policy "own link update" on public.basecamp_links for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "own link delete" on public.basecamp_links;
create policy "own link delete" on public.basecamp_links for delete to authenticated using (user_id = auth.uid());
