-- Durable source-task ledger. Opt-in RPCs only; the existing collector is unchanged.
alter table public.job_source_directory
  add column collection_interval_seconds integer not null default 21600
    check(collection_interval_seconds between 600 and 604800),
  add column next_due_at timestamptz not null default now();
create index catalog_sources_due_idx on public.job_source_directory(next_due_at,id) where enabled;

create table public.catalog_source_tasks (
  id uuid primary key default gen_random_uuid(),
  source_id text not null references public.job_source_directory(id),
  source_config_hash text not null,
  state text not null default 'pending' check(state in ('pending','running','waiting','completed','failed')),
  dispatch_generation integer not null default 1 check(dispatch_generation>0),
  run_id uuid unique references public.job_catalog_runs(id),
  not_before timestamptz not null default now(),
  lease_token uuid,
  lease_until timestamptz,
  attempts integer not null default 0 check(attempts>=0),
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  check((state='running')=(lease_token is not null and lease_until is not null))
);
create unique index catalog_source_tasks_active_idx on public.catalog_source_tasks(source_id)
  where state in ('pending','running','waiting');
create index catalog_source_tasks_due_idx on public.catalog_source_tasks(not_before,id)
  where state in ('pending','running','waiting');

-- Preserve aliases when an operator request joins an existing scheduled task.
create index catalog_source_tasks_running_idx on public.catalog_source_tasks(lease_until) where state='running';
create table public.catalog_source_task_requests (
  source_id text not null references public.job_source_directory(id),
  request_key text not null check(length(request_key) between 1 and 160),
  task_id uuid not null references public.catalog_source_tasks(id),
  primary key(source_id,request_key)
);
create index catalog_task_requests_task_idx on public.catalog_source_task_requests(task_id);
create table public.catalog_task_outbox (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.catalog_source_tasks(id),
  dispatch_generation integer not null check(dispatch_generation>0),
  available_at timestamptz not null default now(),
  lease_token uuid,
  lease_until timestamptz,
  sent_at timestamptz,
  message_id text,
  unique(task_id,dispatch_generation)
);
create index catalog_task_outbox_pending_idx on public.catalog_task_outbox(available_at,id) where sent_at is null;
alter table public.catalog_source_tasks enable row level security;
alter table public.catalog_source_task_requests enable row level security;
alter table public.catalog_task_outbox enable row level security;
revoke all on public.catalog_source_tasks,public.catalog_source_task_requests,public.catalog_task_outbox from public,anon,authenticated;
grant all on public.catalog_source_tasks,public.catalog_source_task_requests,public.catalog_task_outbox to service_role;

create function public.request_catalog_source_task(p_source text,p_request_key text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare d public.job_source_directory; task public.catalog_source_tasks; fingerprint text; budget bigint; reserved bigint;
begin
  if p_request_key is null or length(trim(p_request_key)) not between 1 and 160 then raise exception 'Invalid source task request key'; end if;
  perform pg_catalog.pg_advisory_xact_lock(730103006);
  -- One short admission transaction per source. Do not wait on a worker task
  -- lock while holding this row: page checkpoints also update source metadata.
  select * into d from public.job_source_directory where id=p_source for update;
  if not found then raise exception 'Source not found'; end if;
  select t.* into task from public.catalog_source_task_requests r join public.catalog_source_tasks t on t.id=r.task_id
    where r.source_id=p_source and r.request_key=p_request_key;
  if found then return to_jsonb(task); end if;
  if not d.enabled then raise exception 'Source is not enabled'; end if;
  if d.kind='linkedin' then raise exception 'Source requires a search-window task'; end if;
  fingerprint:=md5(jsonb_build_array(d.id,d.kind,d.board,d.company,to_jsonb(d)->'config')::text);
  select * into task from public.catalog_source_tasks where source_id=p_source and state in ('pending','running','waiting');
  if found and task.source_config_hash<>fingerprint then raise exception 'Source task configuration changed'; end if;
  select budget_bytes into strict budget from public.catalog_capacity_control where singleton;
  select coalesce(sum(bytes),0) into reserved from public.catalog_storage_reservations where expires_at>now();
  if pg_catalog.pg_database_size(current_database())+reserved+16384>budget then
    raise exception 'Catalogue storage budget reached; source task admission paused';
  end if;
  if task.id is null then
    if exists(select 1 from public.job_catalog_sources s join public.job_catalog_runs r on r.id=s.current_run
      where s.id=p_source and r.status<>'succeeded') then raise exception 'Existing source collection must finish before task admission'; end if;
    insert into public.catalog_source_tasks(source_id,source_config_hash) values(p_source,fingerprint) returning * into task;
    insert into public.catalog_task_outbox(task_id,dispatch_generation) values(task.id,task.dispatch_generation);
  end if;
  insert into public.catalog_source_task_requests(source_id,request_key,task_id) values(p_source,p_request_key,task.id);
  return to_jsonb(task);
end $$;

create function public.claim_catalog_task_outbox(p_limit integer default 20) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare result jsonb;
begin
  if p_limit is null or p_limit not between 1 and 100 then raise exception 'Invalid outbox batch limit'; end if;
  with picked as materialized (
    select o.id from public.catalog_task_outbox o join public.catalog_source_tasks t on t.id=o.task_id
    where o.sent_at is null and o.available_at<=now() and (o.lease_until is null or o.lease_until<=now())
      and t.dispatch_generation=o.dispatch_generation and t.state in ('pending','waiting') and t.not_before<=now()
    order by o.available_at,o.id limit p_limit for update of o skip locked
  ), claimed as (
    update public.catalog_task_outbox o set lease_token=gen_random_uuid(),lease_until=now()+interval '2 minutes'
    from picked p where o.id=p.id returning o.*
  ) select coalesce(jsonb_agg(to_jsonb(c)),'[]') into result from claimed c;
  return result;
end $$;
revoke all on function public.request_catalog_source_task(text,text),public.claim_catalog_task_outbox(integer) from public,anon,authenticated;
grant execute on function public.request_catalog_source_task(text,text),public.claim_catalog_task_outbox(integer) to service_role;

create function public.claim_catalog_source_task(p_id uuid,p_generation integer) returns jsonb
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
  run:=public.begin_catalog_run(task.source_id);
  if run is null then return jsonb_build_object('claimed',false,'reason','source_leased'); end if;
  if coalesce((run->>'deferred')::boolean,false) then return jsonb_build_object('claimed',false,'reason','deferred','retry_at',run->'retry_at'); end if;
  if task.run_id is not null and task.run_id is distinct from (run->>'id')::uuid then raise exception 'Source task run ownership lost'; end if;
  update public.catalog_source_tasks set state='running',run_id=(run->>'id')::uuid,lease_token=(run->>'token')::uuid,
    lease_until=now()+interval '5 minutes',attempts=attempts+1,updated_at=now() where id=p_id returning * into task;
  return to_jsonb(task)||jsonb_build_object('claimed',true,'run',run);
end $$;
revoke all on function public.claim_catalog_source_task(uuid,integer) from public,anon,authenticated;
grant execute on function public.claim_catalog_source_task(uuid,integer) to service_role;

create table public.catalog_source_task_receipts (
  task_id uuid not null references public.catalog_source_tasks(id),
  run_id uuid not null references public.job_catalog_runs(id),
  operation text not null check(operation in ('page','publish')),
  page integer not null,
  payload_hash text not null,
  attempt_token uuid not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key(task_id,operation,page),
  unique(run_id,operation,page),
  check((operation='page' and page>0) or (operation='publish' and page=0))
);
alter table public.catalog_source_task_receipts enable row level security;
revoke all on public.catalog_source_task_receipts from public,anon,authenticated;
grant all on public.catalog_source_task_receipts to service_role;

-- Internal storage seam: lock task ownership, then let the existing collector
-- RPC acquire the source row and recheck its final publication fence.
-- Non-key task locks allow joined-request foreign-key checks during page and
-- publication writes; stronger task locks can invert the capacity-lock order.
create function public.lock_catalog_source_task(p_id uuid,p_token uuid) returns public.catalog_source_tasks
language plpgsql security invoker set search_path='' as $$
declare task public.catalog_source_tasks;
begin
  select * into task from public.catalog_source_tasks where id=p_id for no key update;
  if not found or task.state<>'running' or p_token is null or task.lease_token is distinct from p_token or task.lease_until<=now()
    then raise exception 'Source task lease lost'; end if;
  if not exists(select 1 from public.job_source_directory d where d.id=task.source_id and d.enabled
    and task.source_config_hash=md5(jsonb_build_array(d.id,d.kind,d.board,d.company,to_jsonb(d)->'config')::text))
    then raise exception 'Source task configuration changed'; end if;
  if not exists(select 1 from public.job_catalog_sources where id=task.source_id and current_run=task.run_id
    and lease_token=p_token and lease_until>now()) then raise exception 'Collection lease lost'; end if;
  return task;
end $$;

create function public.checkpoint_catalog_source_task(p_id uuid,p_token uuid,p_page integer,p_next integer,
  p_jobs jsonb,p_fetched integer,p_rejected integer,p_requests integer) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare task public.catalog_source_tasks; receipt public.catalog_source_task_receipts; fingerprint text; result jsonb;
begin
  task:=public.lock_catalog_source_task(p_id,p_token);
  if p_page is null or p_page<1 or coalesce(p_fetched,-1)<0 or coalesce(p_rejected,-1)<0 or coalesce(p_requests,0)<1
    then raise exception 'Invalid task page'; end if;
  fingerprint:=encode(sha256(convert_to(jsonb_build_array(p_next,p_jobs,p_fetched,p_rejected,p_requests)::text,'UTF8')),'hex');
  select * into receipt from public.catalog_source_task_receipts where task_id=p_id and operation='page' and page=p_page;
  if found then
    if receipt.payload_hash<>fingerprint then raise exception 'Source task page receipt conflict'; end if;
    return receipt.result;
  end if;
  -- Reserve page growth plus receipt/index headroom in this same transaction.
  perform public.reserve_catalog_storage(task.run_id,p_token,'checkpoint',octet_length(p_jobs::text)::bigint*4+8192);
  perform public.checkpoint_catalog_page(task.run_id,p_token,p_page,p_next,p_jobs,p_fetched,p_rejected,p_requests);
  select to_jsonb(r) into result from public.job_catalog_runs r where id=task.run_id;
  insert into public.catalog_source_task_receipts(task_id,run_id,operation,page,payload_hash,attempt_token,result)
    values(p_id,task.run_id,'page',p_page,fingerprint,p_token,result);
  update public.catalog_source_tasks set lease_until=now()+interval '5 minutes',updated_at=now() where id=p_id;
  return result;
end $$;

create function public.read_catalog_source_task(p_id uuid) returns jsonb
language sql stable security invoker set search_path='' as $$
  select to_jsonb(t)||jsonb_build_object('run',to_jsonb(r),'receipt_count',
    (select count(*) from public.catalog_source_task_receipts x where x.task_id=t.id))
  from public.catalog_source_tasks t left join public.job_catalog_runs r on r.id=t.run_id where t.id=p_id;
$$;
revoke all on function public.read_catalog_source_task(uuid),public.lock_catalog_source_task(uuid,uuid),public.checkpoint_catalog_source_task(uuid,uuid,integer,integer,jsonb,integer,integer,integer) from public,anon,authenticated;
grant execute on function public.read_catalog_source_task(uuid),public.lock_catalog_source_task(uuid,uuid),public.checkpoint_catalog_source_task(uuid,uuid,integer,integer,jsonb,integer,integer,integer) to service_role;

create function public.confirm_catalog_task_outbox(p_id uuid,p_token uuid,p_message_id text) returns boolean
language plpgsql security invoker set search_path='' as $$
declare intent public.catalog_task_outbox;
begin
  if p_token is null or p_message_id is null or length(p_message_id) not between 1 and 200 then raise exception 'Invalid outbox confirmation'; end if;
  select * into intent from public.catalog_task_outbox where id=p_id for update;
  if not found or intent.lease_token is distinct from p_token then return false; end if;
  if not exists(select 1 from public.catalog_source_tasks where id=intent.task_id and dispatch_generation=intent.dispatch_generation)
    then return false; end if;
  if intent.sent_at is not null then return intent.message_id=p_message_id; end if;
  if intent.lease_until is null or intent.lease_until<=now() then return false; end if;
  update public.catalog_task_outbox set sent_at=now(),message_id=p_message_id,lease_until=null where id=p_id;
  return true;
end $$;

create function public.recover_catalog_source_tasks(p_limit integer default 20) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare task public.catalog_source_tasks; result jsonb:='[]'::jsonb; budget bigint; reserved bigint;
begin
  if p_limit is null or p_limit not between 1 and 100 then raise exception 'Invalid recovery batch limit'; end if;
  perform pg_catalog.pg_advisory_xact_lock(730103006);
  select budget_bytes into strict budget from public.catalog_capacity_control where singleton;
  select coalesce(sum(bytes),0) into reserved from public.catalog_storage_reservations where expires_at>now();
  if pg_catalog.pg_database_size(current_database())+reserved+p_limit::bigint*4096>budget then
    raise exception 'Catalogue storage budget reached; source task recovery paused';
  end if;
  for task in
    select t.* from public.catalog_source_tasks t where t.state in ('pending','running','waiting') and t.not_before<=now()
      and ((t.state='running' and t.lease_until<=now()) or
        (t.state in ('pending','waiting') and exists(select 1 from public.catalog_task_outbox o where o.task_id=t.id
          and o.dispatch_generation=t.dispatch_generation and o.sent_at<=now()-interval '5 minutes')))
      and not exists(select 1 from public.job_catalog_sources s left join public.job_catalog_runs r on r.id=s.current_run
        where s.id=t.source_id and (s.lease_until>now() or (r.status<>'succeeded' and r.retry_at>now())))
    order by t.not_before,t.id limit p_limit for update of t skip locked
  loop
    update public.catalog_source_tasks set state='pending',dispatch_generation=dispatch_generation+1,
      lease_token=null,lease_until=null,updated_at=now() where id=task.id returning * into task;
    insert into public.catalog_task_outbox(task_id,dispatch_generation) values(task.id,task.dispatch_generation);
    result:=result||jsonb_build_array(to_jsonb(task));
  end loop;
  return result;
end $$;
revoke all on function public.confirm_catalog_task_outbox(uuid,uuid,text),public.recover_catalog_source_tasks(integer) from public,anon,authenticated;
grant execute on function public.confirm_catalog_task_outbox(uuid,uuid,text),public.recover_catalog_source_tasks(integer) to service_role;

create function public.finish_catalog_source_task(p_id uuid,p_token uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare task public.catalog_source_tasks; receipt public.catalog_source_task_receipts; published jsonb; budget bigint; reserved bigint;
begin
  select * into task from public.catalog_source_tasks where id=p_id for no key update;
  if not found then raise exception 'Source task not found'; end if;
  select * into receipt from public.catalog_source_task_receipts where task_id=p_id and operation='publish' and page=0;
  if found then
    -- This is a read of a committed result, not renewed authority to write.
    if p_token is null or receipt.attempt_token is distinct from p_token then raise exception 'Source task lease lost'; end if;
    return receipt.result;
  end if;
  task:=public.lock_catalog_source_task(p_id,p_token);
  perform public.reserve_catalog_storage(task.run_id,p_token,'publish',0);
  select budget_bytes into strict budget from public.catalog_capacity_control where singleton;
  select coalesce(sum(bytes),0) into reserved from public.catalog_storage_reservations where expires_at>now();
  if pg_catalog.pg_database_size(current_database())+reserved+8192>budget then
    raise exception 'Catalogue storage budget reached; publication receipt paused';
  end if;
  published:=public.finish_catalog_run(task.run_id,p_token);
  insert into public.catalog_source_task_receipts(task_id,run_id,operation,page,payload_hash,attempt_token,result)
    values(p_id,task.run_id,'publish',0,encode(sha256(convert_to(task.run_id::text,'UTF8')),'hex'),p_token,published);
  update public.catalog_source_tasks set state='completed',result=published,finished_at=now(),updated_at=now(),
    lease_token=null,lease_until=null where id=p_id;
  update public.job_source_directory d set next_due_at=now()+make_interval(secs=>d.collection_interval_seconds)
    where id=task.source_id and enabled
      and task.source_config_hash=md5(jsonb_build_array(d.id,d.kind,d.board,d.company,to_jsonb(d)->'config')::text);
  if not found then raise exception 'Source task configuration changed'; end if;
  return published;
end $$;
revoke all on function public.finish_catalog_source_task(uuid,uuid) from public,anon,authenticated;
grant execute on function public.finish_catalog_source_task(uuid,uuid) to service_role;
