create table public.catalog_refresh_runs (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'queued' check(status in ('queued','running','completed','partial','paused','failed','interrupted')),
  workflow_id text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  targets jsonb,
  last_step_id text,
  last_result jsonb,
  published_snapshots integer not null default 0,
  published_records bigint not null default 0,
  result jsonb
);
create table public.catalog_refresh_control (
  singleton boolean primary key default true check(singleton),
  current_run uuid references public.catalog_refresh_runs(id),
  lease_until timestamptz
);
insert into public.catalog_refresh_control(singleton) values(true);
alter table public.catalog_refresh_runs enable row level security;
alter table public.catalog_refresh_control enable row level security;
revoke all on public.catalog_refresh_runs,public.catalog_refresh_control from public,anon,authenticated;
grant all on public.catalog_refresh_runs,public.catalog_refresh_control to service_role;

create function public.claim_catalog_refresh() returns jsonb
language plpgsql security invoker set search_path='' as $$
declare state public.catalog_refresh_control; run public.catalog_refresh_runs;
begin
  select * into state from public.catalog_refresh_control where singleton for update;
  if state.lease_until>now() then
    select * into run from public.catalog_refresh_runs where id=state.current_run;
    return jsonb_build_object('claimed',false,'id',run.id,'workflow_id',run.workflow_id,'status',run.status);
  end if;
  update public.catalog_refresh_runs set status='interrupted',finished_at=now()
    where id=state.current_run and status in ('queued','running');
  insert into public.catalog_refresh_runs default values returning * into run;
  update public.catalog_refresh_control set current_run=run.id,lease_until=now()+interval '10 minutes' where singleton;
  return jsonb_build_object('claimed',true,'id',run.id,'status',run.status);
end $$;
create function public.heartbeat_catalog_refresh(p_id uuid) returns void
language plpgsql security invoker set search_path='' as $$
begin
  perform 1 from public.catalog_refresh_control where singleton and current_run=p_id and lease_until>now() for update;
  if not found then raise exception 'Catalogue refresh lease lost'; end if;
  update public.catalog_refresh_control set lease_until=now()+interval '10 minutes' where singleton;
  update public.catalog_refresh_runs set status='running' where id=p_id;
end $$;
create function public.record_catalog_refresh_step(p_id uuid,p_step_id text,p_result jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare run public.catalog_refresh_runs;
begin
  perform public.heartbeat_catalog_refresh(p_id);
  select * into run from public.catalog_refresh_runs where id=p_id for update;
  if run.last_step_id=p_step_id then return run.last_result; end if;
  if coalesce(length(p_step_id),0)<1 or coalesce((p_result->>'published')::integer,-1)<0 or coalesce((p_result->>'records')::bigint,-1)<0 then
    raise exception 'Invalid refresh result';
  end if;
  update public.catalog_refresh_runs set last_step_id=p_step_id,last_result=p_result,
    published_snapshots=published_snapshots+(p_result->>'published')::integer,
    published_records=published_records+(p_result->>'records')::bigint where id=p_id;
  return p_result;
end $$;
create function public.finish_catalog_refresh(p_id uuid,p_status text,p_result jsonb) returns void
language plpgsql security invoker set search_path='' as $$
begin
  if p_status not in ('completed','partial','paused','failed') then raise exception 'Invalid refresh terminal state'; end if;
  perform public.heartbeat_catalog_refresh(p_id);
  update public.catalog_refresh_runs set status=p_status,finished_at=now(),result=p_result where id=p_id;
  update public.catalog_refresh_control set lease_until=null where singleton and current_run=p_id;
end $$;
revoke all on function public.claim_catalog_refresh(),public.heartbeat_catalog_refresh(uuid),public.record_catalog_refresh_step(uuid,text,jsonb),public.finish_catalog_refresh(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.claim_catalog_refresh(),public.heartbeat_catalog_refresh(uuid),public.record_catalog_refresh_step(uuid,text,jsonb),public.finish_catalog_refresh(uuid,text,jsonb) to service_role;
