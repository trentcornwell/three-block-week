-- 8. Keeps two updates from posting to Basecamp at the same time.
alter table public.publish_settings add column if not exists lock_until timestamptz;

create or replace function public.publish_lock(p_key text)
returns boolean language plpgsql security definer set search_path = public as $$
declare got int;
begin
  if not public.publish_key_ok(p_key) then raise exception 'bad key'; end if;
  update public.publish_settings set lock_until = now() + interval '75 seconds'
  where id = 1 and (lock_until is null or lock_until < now());
  get diagnostics got = row_count;
  return got = 1;
end $$;
revoke execute on function public.publish_lock(text) from public;
grant execute on function public.publish_lock(text) to anon, authenticated;

create or replace function public.publish_unlock(p_key text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.publish_key_ok(p_key) then raise exception 'bad key'; end if;
  update public.publish_settings set lock_until = null where id = 1;
end $$;
revoke execute on function public.publish_unlock(text) from public;
grant execute on function public.publish_unlock(text) to anon, authenticated;
