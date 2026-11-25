-- Bounded single-lane worker operations. No scheduler or queue is enabled.
alter table public.catalog_source_tasks add column failure_count integer not null default 0 check(failure_count>=0);
create table public.catalog_source_task_releases (
  task_id uuid not null references public.catalog_source_tasks(id),
  attempt_token uuid not null,
  payload_hash text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key(task_id,attempt_token)
);
alter table public.catalog_source_task_releases enable row level security;
revoke all on public.catalog_source_task_releases from public,anon,authenticated;
grant all on public.catalog_source_task_releases to service_role;

create function public.read_catalog_source_work(p_id uuid,p_token uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare task public.catalog_source_tasks; result jsonb;
begin
  task:=public.lock_catalog_source_task(p_id,p_token);
  select jsonb_build_object('source',to_jsonb(d),'run',to_jsonb(r),
    'capacity',jsonb_build_object('bytes',pg_catalog.pg_database_size(current_database()),
      'budget',(select budget_bytes from public.catalog_capacity_control where singleton)),
    'records',(select count(*) from public.job_catalog_run_items where run_id=task.run_id),
    'bytes',(select coalesce(sum(octet_length(data::text)),0) from public.job_catalog_run_items where run_id=task.run_id))
    into result from public.job_source_directory d,public.job_catalog_runs r where d.id=task.source_id and r.id=task.run_id;
  return result;
end $$;

create function public.checkpoint_catalog_source_work(p_id uuid,p_token uuid,p_page integer,p_next integer,
  p_jobs jsonb,p_fetched integer,p_rejected integer,p_requests integer,p_max_records integer,p_max_bytes bigint,p_max_pages integer default 1000) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare task public.catalog_source_tasks; records bigint; bytes bigint; result jsonb;
begin
  task:=public.lock_catalog_source_task(p_id,p_token);
  if p_max_records is null or p_max_records not between 1 and 100000 or p_max_bytes is null or p_max_bytes not between 1 and 67108864
    or p_max_pages is null or p_max_pages not between 1 and 10000
    then raise exception 'Invalid worker snapshot limits'; end if;
  if not exists(select 1 from public.catalog_source_task_receipts where task_id=p_id and operation='page' and page=p_page) then
    if (select pages from public.job_catalog_runs where id=task.run_id)>=p_max_pages then raise exception 'Worker snapshot limit reached'; end if;
    select count(*),coalesce(sum(octet_length(data::text)),0) into records,bytes from public.job_catalog_run_items where run_id=task.run_id;
    if records+jsonb_array_length(p_jobs)>p_max_records or bytes+octet_length(p_jobs::text)>p_max_bytes
      then raise exception 'Worker snapshot limit reached'; end if;
    result:=public.checkpoint_catalog_source_task(p_id,p_token,p_page,p_next,p_jobs,p_fetched,p_rejected,p_requests);
    update public.catalog_source_tasks set failure_count=0 where id=p_id;
    return result;
  end if;
  return public.checkpoint_catalog_source_task(p_id,p_token,p_page,p_next,p_jobs,p_fetched,p_rejected,p_requests);
end $$;

create function public.release_catalog_source_work(p_id uuid,p_token uuid,p_mode text,p_reason text,
  p_requests integer default 0,p_retry_at timestamptz default null) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare task public.catalog_source_tasks; receipt public.catalog_source_task_releases; fingerprint text;
  next_state text; due timestamptz; retries integer; released jsonb; source public.job_catalog_sources;
begin
  if p_mode is null or p_mode not in ('continue','retry','failed') or p_reason is null or p_reason not in
    ('page_budget','time_budget','request_budget','provider_backoff','network_error','invalid_source','incomplete_inventory','snapshot_limit','storage_budget','worker_error')
    or p_requests is null or p_requests not between 0 and 100 or (p_retry_at is not null and not isfinite(p_retry_at))
    then raise exception 'Invalid worker release'; end if;
  fingerprint:=encode(sha256(convert_to(jsonb_build_array(p_mode,p_reason,p_requests,extract(epoch from p_retry_at))::text,'UTF8')),'hex');
  select * into task from public.catalog_source_tasks where id=p_id for no key update;
  if not found then raise exception 'Source task not found'; end if;
  select * into receipt from public.catalog_source_task_releases where task_id=p_id and attempt_token=p_token;
  if found then
    if receipt.payload_hash<>fingerprint then raise exception 'Worker release receipt conflict'; end if;
    return receipt.result;
  end if;
  if task.state<>'running' or p_token is null or task.lease_token is distinct from p_token or task.lease_until<=now()
    then raise exception 'Source task lease lost'; end if;
  select * into source from public.job_catalog_sources where id=task.source_id for update;
  if source.current_run is distinct from task.run_id or source.lease_token is distinct from p_token or source.lease_until<=now()
    then raise exception 'Collection lease lost'; end if;
  retries:=case when p_mode='continue' then task.failure_count else task.failure_count+1 end;
  next_state:=case when p_mode='failed' or (p_mode='retry' and retries>=5) then 'failed'
    when p_mode='retry' then 'waiting' else 'pending' end;
  due:=case when p_mode='retry' then greatest(now()+interval '1 minute',
    coalesce(p_retry_at,now()+make_interval(secs=>least(21600,60*power(2,least(retries,8))::integer))),
    (select retry_at from public.job_catalog_runs where id=task.run_id)) else now() end;
  -- Commit release/continuation together. No network operation runs in SQL.
  perform public.pause_catalog_run(task.run_id,p_token,case when p_mode='continue' then null else p_reason end,p_requests);
  update public.job_catalog_runs set retry_at=case when next_state='waiting' then due else null end where id=task.run_id;
  released:=jsonb_build_object('state',next_state,'reason',p_reason,'dispatch_generation',task.dispatch_generation+1,
    'not_before',due,'failure_count',retries);
  update public.catalog_source_tasks set state=next_state,not_before=due,failure_count=retries,result=released,
    dispatch_generation=dispatch_generation+1,lease_token=null,lease_until=null,updated_at=now(),
    finished_at=case when next_state='failed' then now() else null end where id=p_id;
  if next_state<>'failed' then
    insert into public.catalog_task_outbox(task_id,dispatch_generation,available_at) values(p_id,task.dispatch_generation+1,due);
  end if;
  insert into public.catalog_source_task_releases(task_id,attempt_token,payload_hash,result) values(p_id,p_token,fingerprint,released);
  return released;
end $$;
revoke all on function public.read_catalog_source_work(uuid,uuid),
  public.checkpoint_catalog_source_work(uuid,uuid,integer,integer,jsonb,integer,integer,integer,integer,bigint,integer),
  public.release_catalog_source_work(uuid,uuid,text,text,integer,timestamptz) from public,anon,authenticated;
grant execute on function public.read_catalog_source_work(uuid,uuid),
  public.checkpoint_catalog_source_work(uuid,uuid,integer,integer,jsonb,integer,integer,integer,integer,bigint,integer),
  public.release_catalog_source_work(uuid,uuid,text,text,integer,timestamptz) to service_role;

-- Legacy callers must not adopt an active or quarantined ledger snapshot when
-- a bounded worker releases its source lease between deliveries.
alter function public.begin_catalog_run(text) rename to begin_catalog_run_without_tasks;
create function public.begin_catalog_run(p_source text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare source public.job_catalog_sources;
begin
  if not exists(select 1 from public.job_source_directory where id=p_source and enabled) then raise exception 'Source is not enabled'; end if;
  insert into public.job_catalog_sources(id) values(p_source) on conflict do nothing;
  -- Match checkpoint ordering: never hold a directory lock while waiting for
  -- a source row already owned by a page checkpoint.
  select * into source from public.job_catalog_sources where id=p_source for update;
  if source.lease_until>now() then return null; end if;
  perform 1 from public.job_source_directory where id=p_source for no key update;
  if exists(select 1 from public.catalog_source_tasks t where t.source_id=p_source and
    (t.state in ('pending','running','waiting') or
      (t.run_id=source.current_run and exists(select 1 from public.job_catalog_runs r where r.id=t.run_id and r.status<>'succeeded'))))
    then return null; end if;
  return public.begin_catalog_run_without_tasks(p_source);
end $$;
revoke all on function public.begin_catalog_run(text),public.begin_catalog_run_without_tasks(text) from public,anon,authenticated;
grant execute on function public.begin_catalog_run(text),public.begin_catalog_run_without_tasks(text) to service_role;

create or replace function public.claim_catalog_source_task(p_id uuid,p_generation integer) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare task public.catalog_source_tasks; d public.job_source_directory; s public.job_catalog_sources; run jsonb;
begin
  -- Slice one deliberately admits only one live task worker across instances.
  perform pg_catalog.pg_advisory_xact_lock(730112039);
  select * into task from public.catalog_source_tasks where id=p_id for no key update;
  if not found then raise exception 'Source task not found'; end if;
  if p_generation is distinct from task.dispatch_generation then
    return jsonb_build_object('claimed',false,'reason','stale_delivery');
  end if;
  if task.state in ('completed','failed') then return to_jsonb(task)||jsonb_build_object('claimed',false,'reason','terminal'); end if;
  if task.state='running' and task.lease_until>now() then return jsonb_build_object('claimed',false,'reason','leased'); end if;
  if task.not_before>now() then return jsonb_build_object('claimed',false,'reason','deferred'); end if;
  if exists(select 1 from public.catalog_source_tasks where id<>p_id and state='running' and lease_until>now()) then
    return jsonb_build_object('claimed',false,'reason','capacity');
  end if;
  select * into d from public.job_source_directory where id=task.source_id;
  if not d.enabled then raise exception 'Source is not enabled'; end if;
  if task.source_config_hash is distinct from md5(jsonb_build_array(d.id,d.kind,d.board,d.company,to_jsonb(d)->'config')::text)
    then raise exception 'Source task configuration changed'; end if;
  insert into public.job_catalog_sources(id) values(task.source_id) on conflict do nothing;
  select * into s from public.job_catalog_sources where id=task.source_id for update;
  if s.lease_until>now() then return jsonb_build_object('claimed',false,'reason','source_leased'); end if;
  if task.run_id is null and exists(select 1 from public.job_catalog_runs where id=s.current_run and status<>'succeeded') then
    return jsonb_build_object('claimed',false,'reason','legacy_collection');
  end if;
  if task.run_id is not null and s.current_run is distinct from task.run_id then raise exception 'Source task run ownership lost'; end if;
  run:=public.begin_catalog_run_without_tasks(task.source_id);
  if run is null then return jsonb_build_object('claimed',false,'reason','source_leased'); end if;
  if coalesce((run->>'deferred')::boolean,false) then return jsonb_build_object('claimed',false,'reason','deferred','retry_at',run->'retry_at'); end if;
  if task.run_id is not null and task.run_id is distinct from (run->>'id')::uuid then raise exception 'Source task run ownership lost'; end if;
  update public.catalog_source_tasks set state='running',run_id=(run->>'id')::uuid,lease_token=(run->>'token')::uuid,
    lease_until=now()+interval '5 minutes',attempts=attempts+1,updated_at=now() where id=p_id returning * into task;
  return to_jsonb(task)||jsonb_build_object('claimed',true,'run',run);
end $$;
