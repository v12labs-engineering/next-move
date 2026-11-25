-- Private durable preparation checkpoints and customer-visible task progress.
alter table public.application_runs add column preparation_token uuid;
create table public.application_tasks (
  application_id uuid not null references public.application_runs(id) on delete cascade,
  revision integer not null,
  stage text not null check (stage in ('load_source','read_employer_form','tailor_resume','validate_packet','check_application','fill_employer_form','submit','confirm')),
  state text not null check (state in ('running','completed','retry_wait','blocked','failed')),
  attempts integer not null default 1 check(attempts between 1 and 3),
  error_code text,
  message text not null default '',
  next_retry_at timestamptz,
  output jsonb,
  updated_at timestamptz not null default now(),
  primary key(application_id,revision,stage)
);
alter table public.application_tasks enable row level security;
revoke all on public.application_tasks from public,anon,authenticated;
-- Checkpoint outputs contain profile facts and never go to the progress client.
grant select(application_id,revision,stage,state,attempts,error_code,message,next_retry_at,updated_at) on public.application_tasks to authenticated;
grant all on public.application_tasks to service_role;
create policy application_task_owner on public.application_tasks for select to authenticated
  using(exists(select 1 from public.application_runs r where r.id=application_id and r.user_id=(select auth.uid())));

create function public.record_application_task(p_id uuid,p_revision integer,p_token uuid,p_stage text,p_action text,p_data jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.application_runs; t public.application_tasks;
begin
  select * into r from public.application_runs where id=p_id for update;
  if not found or r.revision<>p_revision then return null; end if;
  if p_stage in ('load_source','read_employer_form','tailor_resume','validate_packet') then
    if r.status<>'preparing' or p_token is null or r.preparation_token is distinct from p_token then return null; end if;
  elsif (r.status not in ('running','submitting') and not(r.status='submitted' and p_stage='confirm' and p_action='complete')) or r.approved_revision is distinct from p_revision then return null;
  end if;
  select * into t from public.application_tasks where application_id=p_id and revision=p_revision and stage=p_stage;
  if p_action='start' then
    if t.state='completed' then return to_jsonb(t); end if;
    if t.next_retry_at>now() or t.attempts>=3 then return null; end if;
    insert into public.application_tasks(application_id,revision,stage,state)
      values(p_id,p_revision,p_stage,'running')
      on conflict(application_id,revision,stage) do update set
        state='running',attempts=application_tasks.attempts+1,next_retry_at=null,updated_at=now()
      returning * into t;
  elsif p_action='complete' then
    update public.application_tasks set state='completed',output=p_data->'output',error_code=null,message='',next_retry_at=null,updated_at=now()
      where application_id=p_id and revision=p_revision and stage=p_stage and state='running' returning * into t;
    if not found then return null; end if;
  elsif p_action='fail' then
    update public.application_tasks set state=p_data->>'state',error_code=p_data->>'error_code',message=p_data->>'message',
      next_retry_at=(p_data->>'next_retry_at')::timestamptz,updated_at=now()
      where application_id=p_id and revision=p_revision and stage=p_stage and state='running' returning * into t;
    if not found then return null; end if;
  else raise exception 'Unknown application task action';
  end if;
  update public.application_runs set updated_at=now() where id=p_id;
  return to_jsonb(t);
end $$;
revoke all on function public.record_application_task(uuid,integer,uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.record_application_task(uuid,integer,uuid,text,text,jsonb) to service_role;

-- A dead preparation worker has never entered candidate data or sent anything.
-- Fence it before redispatching. Sending/submitting records are never reclaimed.
create function public.recover_application_preparation(p_user uuid default null) returns integer
language plpgsql security definer set search_path='' as $$
declare n integer;
begin
  with stale as (
    select id from public.application_runs
    where status='preparing' and automatic and updated_at<now()-interval '10 minutes'
      and (p_user is null or user_id=p_user)
    order by updated_at limit 100 for update skip locked
  ) update public.application_runs r set
    status=case when exists(select 1 from public.application_tasks t where t.application_id=r.id and t.revision=r.revision and t.state<>'completed' and t.attempts>=3) then 'needs_attention' else 'queued_prepare' end,
    preparation_token=null,
    message='The preparation worker stopped. Completed tasks are saved; unfinished preparation can resume safely.',
    updated_at=now()-interval '1 minute 1 second'
    from stale where r.id=stale.id;
  get diagnostics n=row_count;
  return n;
end $$;
revoke all on function public.recover_application_preparation(uuid) from public,anon,authenticated;
grant execute on function public.recover_application_preparation(uuid) to service_role;

create function public.claim_application_preparation(p_id uuid,p_token uuid) returns setof public.application_runs
language plpgsql security definer set search_path='' as $$
begin
  return query update public.application_runs r set status='preparing',preparation_token=p_token,started_at=now(),updated_at=now()
    where r.id=p_id and r.status='queued_prepare'
    and not exists(select 1 from public.application_tasks t where t.application_id=r.id and t.revision=r.revision and t.next_retry_at>now())
    returning r.*;
end $$;
revoke all on function public.claim_application_preparation(uuid,uuid) from public,anon,authenticated;
grant execute on function public.claim_application_preparation(uuid,uuid) to service_role;
