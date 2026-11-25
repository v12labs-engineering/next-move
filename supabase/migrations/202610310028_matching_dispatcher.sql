-- One recovery dispatcher watches queued work even after clients disconnect.
alter table public.matching_capacity add column dispatcher_token uuid, add column dispatcher_until timestamptz;
create function public.claim_matching_dispatcher() returns uuid
language plpgsql security definer set search_path='' as $$
declare t uuid;
begin
  if not exists(select 1 from public.account_match_state where queued_at is not null) then return null; end if;
  update public.matching_capacity set dispatcher_token=gen_random_uuid(),dispatcher_until=now()+interval '5 minutes'
    where singleton and (dispatcher_until is null or dispatcher_until<=now()) returning dispatcher_token into t;
  return t;
end $$;
create function public.heartbeat_matching_dispatcher(p_token uuid) returns boolean
language plpgsql security definer set search_path='' as $$
begin
  -- Queue admissions lock the same row via the common admission advisory lock.
  perform pg_advisory_xact_lock(730103023);
  if not exists(select 1 from public.matching_capacity where singleton and dispatcher_token=p_token and dispatcher_until>now()) then return false; end if;
  if not exists(select 1 from public.account_match_state where queued_at is not null) then
    update public.matching_capacity set dispatcher_token=null,dispatcher_until=null where singleton and dispatcher_token=p_token;
    return false;
  end if;
  update public.matching_capacity set dispatcher_until=now()+interval '5 minutes' where singleton and dispatcher_token=p_token;
  return true;
end $$;
create function public.release_matching_dispatcher(p_token uuid) returns void
language sql security definer set search_path='' as $$
  update public.matching_capacity set dispatcher_token=null,dispatcher_until=null where singleton and dispatcher_token=p_token;
$$;
revoke all on function public.claim_matching_dispatcher(),public.heartbeat_matching_dispatcher(uuid),public.release_matching_dispatcher(uuid) from public,anon,authenticated;
grant execute on function public.claim_matching_dispatcher(),public.heartbeat_matching_dispatcher(uuid),public.release_matching_dispatcher(uuid) to service_role;
