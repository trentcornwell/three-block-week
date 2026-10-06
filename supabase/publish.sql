-- 7. Weekly staff plan posted to a Basecamp project (Docs & Files).
-- Safe to run more than once.
create table if not exists public.publish_settings (
  id             int primary key default 1 check (id = 1),
  publisher      uuid references auth.users on delete set null,
  publisher_name text,
  account_id     text,
  bucket_id      text,
  vault_id       text,
  project_name   text,
  enabled        boolean not null default false,
  docs           jsonb not null default '{}'::jsonb,
  last_run       timestamptz,
  last_error     text,
  updated_at     timestamptz not null default now()
);
alter table public.publish_settings enable row level security;
drop policy if exists "staff read publish" on public.publish_settings;
create policy "staff read publish" on public.publish_settings for select to authenticated using (public.is_staff());

-- Holds only a hash of the server's publishing key. No policies: nobody can read it directly.
create table if not exists public.publish_secret (
  id        int primary key default 1 check (id = 1),
  key_hash  text not null
);
alter table public.publish_secret enable row level security;

create or replace function public.publish_key_ok(p_key text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select key_hash = encode(sha256(convert_to(coalesce(p_key, ''), 'UTF8')), 'hex') from public.publish_secret where id = 1), false);
$$;
revoke execute on function public.publish_key_ok(text) from public, anon, authenticated;

-- A staff member turns posting on, using their own Basecamp connection.
create or replace function public.publish_setup(p_key text, p_account text, p_bucket text, p_vault text, p_project text, p_name text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'not staff'; end if;
  insert into public.publish_secret (id, key_hash) values (1, encode(sha256(convert_to(p_key, 'UTF8')), 'hex'))
    on conflict (id) do update set key_hash = excluded.key_hash;
  insert into public.publish_settings as s (id, publisher, publisher_name, account_id, bucket_id, vault_id, project_name, enabled, updated_at)
    values (1, auth.uid(), p_name, p_account, p_bucket, p_vault, p_project, true, now())
  on conflict (id) do update set
    publisher = excluded.publisher, publisher_name = excluded.publisher_name, account_id = excluded.account_id,
    docs = case when s.bucket_id is distinct from excluded.bucket_id then '{}'::jsonb else s.docs end,
    bucket_id = excluded.bucket_id, vault_id = excluded.vault_id, project_name = excluded.project_name,
    enabled = true, last_error = null, updated_at = now();
end $$;
revoke execute on function public.publish_setup(text, text, text, text, text, text) from public, anon;
grant execute on function public.publish_setup(text, text, text, text, text, text) to authenticated;

create or replace function public.publish_off()
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'not staff'; end if;
  update public.publish_settings set enabled = false, updated_at = now() where id = 1;
end $$;
revoke execute on function public.publish_off() from public, anon;
grant execute on function public.publish_off() to authenticated;

-- Used by the site's server (with its key) to read one week for every staff member.
create or replace function public.publish_data(p_key text, p_week date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s public.publish_settings;
begin
  if not public.publish_key_ok(p_key) then raise exception 'bad key'; end if;
  select * into s from public.publish_settings where id = 1;
  return jsonb_build_object(
    'settings', to_jsonb(s),
    'blob',   (select blob from public.basecamp_links where user_id = s.publisher),
    'people', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'email', p.email) order by p.name)
                        from public.profiles p where exists (select 1 from public.staff st where lower(st.email) = lower(p.email))), '[]'::jsonb),
    'days',   coalesce((select jsonb_agg(jsonb_build_object('user_id', d.user_id, 'date', d.date, 'data', d.data))
                        from public.days d where d.date between p_week and p_week + 6), '[]'::jsonb),
    'weeks',  coalesce((select jsonb_agg(jsonb_build_object('user_id', w.user_id, 'data', w.data))
                        from public.weeks w where w.week_start = p_week), '[]'::jsonb)
  );
end $$;
revoke execute on function public.publish_data(text, date) from public;
grant execute on function public.publish_data(text, date) to anon, authenticated;

-- Records what was posted, and saves a refreshed Basecamp connection for the publisher.
create or replace function public.publish_save(p_key text, p_week text, p_doc jsonb, p_error text, p_blob text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.publish_key_ok(p_key) then raise exception 'bad key'; end if;
  update public.publish_settings set last_run = now(), last_error = p_error,
    docs = case when p_doc is null or p_week is null then docs else docs || jsonb_build_object(p_week, p_doc) end
  where id = 1;
  if p_blob is not null then
    update public.basecamp_links set blob = p_blob, updated_at = now()
    where user_id = (select publisher from public.publish_settings where id = 1);
  end if;
end $$;
revoke execute on function public.publish_save(text, text, jsonb, text, text) from public;
grant execute on function public.publish_save(text, text, jsonb, text, text) to anon, authenticated;

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'publish_settings') then
    alter publication supabase_realtime add table public.publish_settings;
  end if;
end $$;
