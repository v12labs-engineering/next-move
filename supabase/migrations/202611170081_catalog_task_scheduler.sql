-- Independent scheduled source tasks. No source is enabled by this migration.
-- Existing catalogue snapshots and the manual/global refresh API are retained.
alter table public.catalog_source_tasks add column priority text not null default 'background'
  check (priority in ('india','background'));
create index catalog_source_tasks_india_history_idx on public.catalog_source_tasks(source_id)
  where priority='india';

create table public.catalog_scheduler_state (
  singleton boolean primary key default true check(singleton),
  last_tick_at timestamptz,
  last_error text,
  error_at timestamptz,
  maintenance_token uuid,
  maintenance_lease_until timestamptz,
  maintenance_last_success_at timestamptz
);
insert into public.catalog_scheduler_state(singleton) values(true);
alter table public.catalog_scheduler_state enable row level security;
revoke all on public.catalog_scheduler_state from public,anon,authenticated;
grant all on public.catalog_scheduler_state to service_role;

-- Directory country hints alone are not validation. Remember previously
-- verified India sources through task history, even during an empty hiring period.
create function public.catalog_source_is_india(p_source text) returns boolean
language sql stable security invoker set search_path='' as $$
  select exists(select 1 from public.job_catalog where source=p_source and country='India')
    or exists(select 1 from public.source_candidates where id=p_source and status='activated'
      and validation->'countries' ? 'India')
    or exists(select 1 from public.catalog_source_tasks where source_id=p_source and priority='india');
$$;

create or replace function public.request_catalog_source_task(p_source text,p_request_key text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare d public.job_source_directory; task public.catalog_source_tasks; fingerprint text; budget bigint;
  reserved bigint; source public.job_catalog_sources; previous public.job_catalog_runs;
  failed_task public.catalog_source_tasks; india boolean;
begin
  if p_request_key is null or length(trim(p_request_key)) not between 1 and 160 then raise exception 'Invalid source task request key'; end if;
  perform pg_catalog.pg_advisory_xact_lock(730103006);
  if not exists(select 1 from public.job_source_directory where id=p_source) then raise exception 'Source not found'; end if;
  -- Match the legacy begin gate's source-before-directory ordering. Reading an
  -- active task below does not take a task lock while owning its source row.
  insert into public.job_catalog_sources(id) values(p_source) on conflict do nothing;
  select * into source from public.job_catalog_sources where id=p_source for update;
  select * into d from public.job_source_directory where id=p_source for update;
  if not found then raise exception 'Source not found'; end if;
  select t.* into task from public.catalog_source_task_requests r join public.catalog_source_tasks t on t.id=r.task_id
    where r.source_id=p_source and r.request_key=p_request_key;
  if found then return to_jsonb(task); end if;
  if not d.enabled then raise exception 'Source is not enabled'; end if;
  if d.kind in ('linkedin','alexandria') then raise exception 'Source requires a separate collection policy'; end if;
  fingerprint:=md5(jsonb_build_array(d.id,d.kind,d.board,d.company,to_jsonb(d)->'config')::text);
  india:=public.catalog_source_is_india(p_source);
  select * into task from public.catalog_source_tasks where source_id=p_source and state in ('pending','running','waiting');
  if found and task.source_config_hash<>fingerprint then raise exception 'Source task configuration changed'; end if;
  select budget_bytes into strict budget from public.catalog_capacity_control where singleton;
  select coalesce(sum(bytes),0) into reserved from public.catalog_storage_reservations where expires_at>now();
  if pg_catalog.pg_database_size(current_database())+reserved+16384>budget then
    raise exception 'Catalogue storage budget reached; source task admission paused';
  end if;
  if task.id is null then
    if source.lease_until>now() then raise exception 'Collection source is leased'; end if;
    select * into previous from public.job_catalog_runs where id=source.current_run and status<>'succeeded';
    if previous.id is not null and previous.source is distinct from p_source then raise exception 'Collection snapshot source mismatch'; end if;
    if previous.retry_at>now() then raise exception 'Collection source is in backoff'; end if;
    select * into failed_task from public.catalog_source_tasks
      where source_id=p_source and run_id is not distinct from source.current_run and state='failed'
      order by created_at desc limit 1;
    if failed_task.not_before>now() then raise exception 'Failed source is in cooldown'; end if;
    if previous.id is not null then
      if failed_task.id is not null then
        -- Only unpublished, abandoned staging is discarded. Published jobs and
        -- the old run/task history remain, and its former worker loses authority.
        delete from public.job_catalog_run_items where run_id=previous.id;
        update public.job_catalog_sources set current_run=null,lease_token=null,lease_until=null where id=p_source;
        previous.id:=null;
      end if;
    end if;
    insert into public.catalog_source_tasks(source_id,source_config_hash,run_id,priority)
      values(p_source,fingerprint,previous.id,case when india then 'india' else 'background' end) returning * into task;
    insert into public.catalog_task_outbox(task_id,dispatch_generation) values(task.id,task.dispatch_generation);
  end if;
  insert into public.catalog_source_task_requests(source_id,request_key,task_id) values(p_source,p_request_key,task.id);
  return to_jsonb(task);
end $$;

create function public.catalog_scheduled_due() returns table(source_id text,priority text,due_at timestamptz)
language sql stable security invoker set search_path='' as $$
  select d.id,case when policy.india then 'india' else 'background' end,
    coalesce(s.last_success_at+make_interval(secs=>case when policy.india then least(d.collection_interval_seconds,3300)
      else d.collection_interval_seconds end),d.next_due_at)
  from public.job_source_directory d
  left join public.job_catalog_sources s on s.id=d.id
  left join public.job_catalog_runs r on r.id=s.current_run
  cross join lateral(select public.catalog_source_is_india(d.id) india) policy
  where d.enabled and d.kind not in ('linkedin','alexandria')
    and (policy.india or coalesce(s.published_count,0)>0 or exists(
      select 1 from public.source_candidates c where c.id=d.id and c.status='activated'))
    and coalesce(s.last_success_at+make_interval(secs=>case when policy.india then least(d.collection_interval_seconds,3300)
      else d.collection_interval_seconds end),d.next_due_at)<=now()
    and (s.lease_until is null or s.lease_until<=now())
    and (r.status='succeeded' or r.retry_at is null or r.retry_at<=now())
    and not exists(select 1 from public.catalog_source_tasks t where t.source_id=d.id
      and (t.state in ('pending','running','waiting') or
        (t.state='failed' and t.run_id is not distinct from s.current_run and t.not_before>now())));
$$;

create function public.admit_catalog_scheduled_tasks(p_limit integer default 100) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare candidate record; admitted jsonb:='[]'::jsonb; errors jsonb:='[]'::jsonb; task jsonb;
  india_count integer; background_count integer;
begin
  if p_limit is null or p_limit not between 1 and 200 then raise exception 'Invalid scheduler admission limit'; end if;
  select count(*) filter(where priority='india'),count(*) filter(where priority='background')
    into india_count,background_count from public.catalog_scheduled_due();
  for candidate in select * from public.catalog_scheduled_due()
    order by case when priority='india' then 0 else 1 end,due_at,source_id limit p_limit
  loop
    begin
      task:=public.request_catalog_source_task(candidate.source_id,
        'scheduled:'||md5(candidate.source_id||':'||candidate.due_at::text||':'||coalesce((
          select t.id::text from public.catalog_source_tasks t join public.job_catalog_sources s
            on s.id=t.source_id and s.current_run is not distinct from t.run_id
          where t.source_id=candidate.source_id and t.state='failed' order by t.created_at desc limit 1),'')));
      if candidate.priority='india' then
        update public.job_source_directory set collection_interval_seconds=least(collection_interval_seconds,3300)
          where id=candidate.source_id;
      end if;
      admitted:=admitted||jsonb_build_array(task);
    exception when others then
      errors:=errors||jsonb_build_array(jsonb_build_object('source',candidate.source_id,'error',left(sqlerrm,300)));
    end;
  end loop;
  return jsonb_build_object('admitted',admitted,'errors',errors,'dueIndia',india_count,'dueBackground',background_count);
end $$;

-- Reserve publisher slots as well as running workers. This prevents a broad
-- backlog from filling the Workflow runtime ahead of newly due India sources.
create function public.claim_catalog_scheduled_outbox(p_limit integer default 4) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare candidate record; intent public.catalog_task_outbox; result jsonb:='[]'::jsonb;
  occupied integer; backgrounds integer;
begin
  if p_limit is null or p_limit not between 1 and 4 then raise exception 'Invalid scheduled dispatch limit'; end if;
  perform pg_catalog.pg_advisory_xact_lock(730112039);
  select count(*),count(*) filter(where t.priority='background') into occupied,backgrounds
  from public.catalog_source_tasks t where
    (t.state='running' and t.lease_until>now()) or
    (t.state in ('pending','waiting') and t.not_before<=now() and exists(
      select 1 from public.catalog_task_outbox o where o.task_id=t.id and o.dispatch_generation=t.dispatch_generation
      and (o.lease_until>now() or o.sent_at>now()-interval '5 minutes')));
  for candidate in
    select o.id,t.source_id,t.priority from public.catalog_task_outbox o
    join public.catalog_source_tasks t on t.id=o.task_id
    where o.sent_at is null and o.available_at<=now() and (o.lease_until is null or o.lease_until<=now())
      and t.dispatch_generation=o.dispatch_generation and t.state in ('pending','waiting') and t.not_before<=now()
    order by case when t.priority='india' then 0 else 1 end,o.available_at,o.id
    for update of o skip locked
  loop
    exit when occupied>=4 or jsonb_array_length(result)>=p_limit;
    if candidate.priority='background' and backgrounds>=1 then continue; end if;
    update public.catalog_task_outbox set lease_token=gen_random_uuid(),lease_until=now()+interval '2 minutes'
      where id=candidate.id returning * into intent;
    result:=result||jsonb_build_array(to_jsonb(intent)||jsonb_build_object('source_id',candidate.source_id,'priority',candidate.priority));
    occupied:=occupied+1;
    if candidate.priority='background' then backgrounds:=backgrounds+1; end if;
  end loop;
  return result;
end $$;

-- A running workflow can consume another source immediately rather than wait
-- for the next cron tick. The delivery reservation and acknowledgement commit
-- together; replay after a lost response returns its existing ready delivery.
create function public.claim_catalog_workflow_delivery(p_message_id text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare delivery jsonb;
begin
  if p_message_id is null or length(p_message_id) not between 1 and 200 then raise exception 'Invalid workflow message'; end if;
  perform pg_catalog.pg_advisory_xact_lock(730112039);
  select jsonb_build_object('task_id',t.id,'dispatch_generation',t.dispatch_generation) into delivery
    from public.catalog_task_outbox o join public.catalog_source_tasks t on t.id=o.task_id
    where o.message_id=p_message_id and o.sent_at>now()-interval '5 minutes'
      and t.dispatch_generation=o.dispatch_generation and t.state in ('pending','waiting') and t.not_before<=now()
      and (t.lease_until is null or t.lease_until<=now())
    order by o.sent_at desc,o.id limit 1;
  if delivery is not null then return delivery; end if;
  select value into delivery from jsonb_array_elements(public.claim_catalog_scheduled_outbox(1)) limit 1;
  if delivery is null then return null; end if;
  if not public.confirm_catalog_task_outbox((delivery->>'id')::uuid,(delivery->>'lease_token')::uuid,p_message_id)
    then return null; end if;
  return jsonb_build_object('task_id',delivery->'task_id','dispatch_generation',delivery->'dispatch_generation');
end $$;

-- The same durable workflow may continue the next bounded page segment. A
-- competing publisher wins if it already leased or dispatched that generation.
create function public.confirm_catalog_task_continuation(p_task uuid,p_generation integer,p_message_id text) returns boolean
language plpgsql security invoker set search_path='' as $$
declare intent public.catalog_task_outbox;
begin
  if p_message_id is null or length(p_message_id) not between 1 and 200 then raise exception 'Invalid continuation message'; end if;
  select * into intent from public.catalog_task_outbox where task_id=p_task and dispatch_generation=p_generation for update;
  if not found or not exists(select 1 from public.catalog_source_tasks where id=p_task
    and dispatch_generation=p_generation and state in ('pending','waiting') and not_before<=now()) then return false; end if;
  if intent.sent_at is not null then return intent.message_id=p_message_id; end if;
  if intent.lease_until>now() then return false; end if;
  update public.catalog_task_outbox set sent_at=now(),message_id=p_message_id,lease_until=null where id=intent.id;
  return true;
end $$;

-- Retain the tested worker's fencing and receipt logic, widening only its
-- global admission gate and adding a reserved India capacity policy.
do $$
declare original text; changed text;
begin
  original:=pg_get_functiondef('public.claim_catalog_source_task(uuid,integer)'::regprocedure);
  changed:=replace(original,
    'if exists(select 1 from public.catalog_source_tasks where id<>p_id and state=''running'' and lease_until>now()) then',
    'if (select count(*) from public.catalog_source_tasks where id<>p_id and state=''running'' and lease_until>now())>=4
      or (task.priority=''background'' and exists(select 1 from public.catalog_source_tasks where id<>p_id
        and priority=''background'' and state=''running'' and lease_until>now())) then');
  if changed=original then raise exception 'Unexpected source worker concurrency gate'; end if;
  execute changed;
  original:=pg_get_functiondef('public.release_catalog_source_work(uuid,uuid,text,text,integer,timestamp with time zone)'::regprocedure);
  changed:=replace(original,
    'due:=case when p_mode=''retry'' then',
    'due:=case when next_state=''failed'' then greatest(now()+case
      when p_mode=''retry'' or p_reason=''storage_budget'' then interval ''1 hour'' else interval ''24 hours'' end,
      p_retry_at,(select retry_at from public.job_catalog_runs where id=task.run_id))
      when p_mode=''retry'' then');
  if changed=original then raise exception 'Unexpected source worker release policy'; end if;
  execute changed;
end $$;

create function public.record_catalog_scheduler_tick(p_error text default null) returns void
language sql security invoker set search_path='' as $$
  update public.catalog_scheduler_state set last_tick_at=now(),last_error=left(p_error,1000),
    error_at=case when p_error is null then null else now() end where singleton;
$$;
create function public.claim_catalog_scheduler_maintenance() returns uuid
language plpgsql security invoker set search_path='' as $$
declare token uuid:=gen_random_uuid();
begin
  update public.catalog_scheduler_state set maintenance_token=token,maintenance_lease_until=now()+interval '10 minutes'
    where singleton and (maintenance_lease_until is null or maintenance_lease_until<=now())
      and (maintenance_last_success_at is null or maintenance_last_success_at<=now()-interval '1 hour');
  if not found then return null; end if;
  return token;
end $$;
create function public.finish_catalog_scheduler_maintenance(p_token uuid) returns void
language plpgsql security invoker set search_path='' as $$
begin
  if exists(select 1 from public.catalog_scheduler_state where singleton and maintenance_token=p_token
    and maintenance_lease_until is null and maintenance_last_success_at is not null) then return; end if;
  update public.catalog_scheduler_state set maintenance_last_success_at=now(),maintenance_lease_until=null
    where singleton and maintenance_token=p_token and maintenance_lease_until>now();
  if not found then raise exception 'Scheduler maintenance lease lost'; end if;
end $$;

create function public.catalog_scheduler_health() returns jsonb
language sql stable security invoker set search_path='' as $$
  with india as (
    select d.id,s.last_success_at from public.job_source_directory d left join public.job_catalog_sources s on s.id=d.id
    where d.enabled and public.catalog_source_is_india(d.id)
  ), due as (select * from public.catalog_scheduled_due()), state as (select * from public.catalog_scheduler_state where singleton)
  select jsonb_build_object(
    'checkedAt',now(),'lastTickAt',state.last_tick_at,'lastError',state.last_error,'errorAt',state.error_at,
    'maintenanceLastSuccessAt',state.maintenance_last_success_at,
    'indiaSources',(select count(*) from india),'oldestIndiaSuccessAt',(select min(last_success_at) from india),
    'neverSuccessfulIndia',(select count(*) from india where last_success_at is null),
    'staleIndia',(select count(*) from india where last_success_at is null or last_success_at<now()-interval '1 hour'),
    'dueIndia',(select count(*) from due where priority='india'),
    'dueBackground',(select count(*) from due where priority='background'),
    'oldestIndiaDueAt',(select min(due_at) from due where priority='india'),
    'runningIndia',(select count(*) from public.catalog_source_tasks where state='running' and priority='india' and lease_until>now()),
    'runningBackground',(select count(*) from public.catalog_source_tasks where state='running' and priority='background' and lease_until>now()),
    'waitingIndia',(select count(*) from public.catalog_source_tasks where state='waiting' and priority='india'),
    'failedIndia',(select count(*) from public.catalog_source_tasks t join public.job_catalog_sources s
      on s.id=t.source_id and s.current_run is not distinct from t.run_id
      where t.state='failed' and t.priority='india'),
    'pendingIndia',(select count(*) from public.catalog_source_tasks where state='pending' and priority='india')) from state;
$$;

revoke all on function public.catalog_source_is_india(text),public.catalog_scheduled_due(),
  public.admit_catalog_scheduled_tasks(integer),public.claim_catalog_scheduled_outbox(integer),
  public.claim_catalog_workflow_delivery(text),
  public.confirm_catalog_task_continuation(uuid,integer,text),public.record_catalog_scheduler_tick(text),
  public.claim_catalog_scheduler_maintenance(),public.finish_catalog_scheduler_maintenance(uuid),
  public.catalog_scheduler_health() from public,anon,authenticated;
grant execute on function public.catalog_source_is_india(text),public.catalog_scheduled_due(),
  public.admit_catalog_scheduled_tasks(integer),public.claim_catalog_scheduled_outbox(integer),
  public.claim_catalog_workflow_delivery(text),
  public.confirm_catalog_task_continuation(uuid,integer,text),public.record_catalog_scheduler_tick(text),
  public.claim_catalog_scheduler_maintenance(),public.finish_catalog_scheduler_maintenance(uuid),
  public.catalog_scheduler_health() to service_role;
