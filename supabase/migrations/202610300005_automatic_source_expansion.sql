create table public.source_expansion_runs (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'running' check(status in ('running','succeeded','failed','interrupted')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  result jsonb
);
create table public.source_expansion_control (
  singleton boolean primary key default true check(singleton),
  current_run uuid references public.source_expansion_runs(id),
  lease_until timestamptz,
  last_started_at timestamptz
);
insert into public.source_expansion_control(singleton) values(true);
alter table public.source_expansion_runs enable row level security;
alter table public.source_expansion_control enable row level security;
revoke all on public.source_expansion_runs,public.source_expansion_control from public,anon,authenticated;
grant all on public.source_expansion_runs,public.source_expansion_control to service_role;

create function public.claim_source_expansion(p_force boolean default false) returns uuid
language plpgsql security invoker set search_path='' as $$
declare state public.source_expansion_control; next_id uuid:=gen_random_uuid();
begin
  select * into state from public.source_expansion_control where singleton for update;
  if state.lease_until>now() or (not p_force and state.last_started_at>now()-interval '1 hour') then return null; end if;
  update public.source_expansion_runs set status='interrupted',finished_at=now()
    where id=state.current_run and status='running';
  insert into public.source_expansion_runs(id) values(next_id);
  update public.source_expansion_control set current_run=next_id,lease_until=now()+interval '5 minutes',last_started_at=now() where singleton;
  return next_id;
end $$;
create function public.finish_source_expansion(p_id uuid,p_result jsonb,p_failed boolean default false) returns void
language plpgsql security invoker set search_path='' as $$
declare state public.source_expansion_control;
begin
  select * into state from public.source_expansion_control where singleton for update;
  if state.current_run is distinct from p_id or state.lease_until<=now() or state.lease_until is null then raise exception 'Expansion lease lost'; end if;
  update public.source_expansion_runs set status=case when p_failed then 'failed' else 'succeeded' end,
    result=p_result,finished_at=now() where id=p_id;
  update public.source_expansion_control set lease_until=null where singleton;
end $$;
revoke all on function public.claim_source_expansion(boolean),public.finish_source_expansion(uuid,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.claim_source_expansion(boolean),public.finish_source_expansion(uuid,jsonb,boolean) to service_role;
