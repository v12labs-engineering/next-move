-- Each explicit retry authorizes a new attempt, not an endless replay of an old send.
-- Answer revisions and pre-send retries stay in that attempt. Only the owner-only
-- uncertain-retry RPC advances this boundary; prior events are retained for audit.
alter table public.application_runs add column attempt_start_revision integer not null default 1
 check(attempt_start_revision between 1 and revision);

create or replace function public.retry_unconfirmed_application(p_id uuid, p_revision integer)
returns integer language plpgsql security definer set search_path='' as $$
declare r public.application_runs;
begin
  select * into r from public.application_runs
    where id=p_id and user_id=auth.uid() for update;
  if not found or r.revision<>p_revision or r.status<>'submission_unknown'
    or r.receipt is not null or coalesce(r.packet,r.approved_packet) is null then return null; end if;
  update public.application_runs set
    status='ready', revision=revision+1, packet=coalesce(packet,approved_packet),
    approved_packet=null, approved_revision=null, approved_at=null,
    automatic=true, auto_submit_requested_at=now(), attempt_start_revision=revision+1, preparation_token=null,
    started_at=null, decision_attempts=0, automatic_retry_count=0, retry_after=null,
    message='Retry authorized. Auto-apply will continue with your saved application. The previous submission was not confirmed.',
    updated_at=now()
    where id=r.id returning revision into p_revision;
  return p_revision;
end $$;

create or replace function public.queue_automatic_application(p_id uuid,p_revision integer) returns boolean
language plpgsql security definer set search_path='' as $$
declare r public.application_runs; owner_id uuid;
begin
  select user_id into owner_id from public.application_runs where id=p_id;
  if not found then return false; end if;
  perform 1 from public.account_profiles where user_id=owner_id for update;
  select * into r from public.application_runs where id=p_id for update;
  if r.revision<>p_revision or r.status<>'ready' or not r.automatic
    or r.packet is null or r.receipt is not null
    or exists(select 1 from public.application_events where application_id=r.id
      and revision>=r.attempt_start_revision and status in ('submitting','submitted','submission_unknown')) then return false; end if;
  if jsonb_typeof(r.packet->'fields') is distinct from 'array'
    or jsonb_typeof(r.packet->'answers') is distinct from 'object'
    or length(coalesce(r.packet->>'resume','')) not between 30 and 50000
    or exists(select 1 from jsonb_array_elements(r.packet->'fields') f
      group by f->>'id' having count(*)>1)
    or exists(select 1 from jsonb_array_elements(r.packet->'fields') f
      where f->>'kind'<>'resume' and
        (coalesce((f->>'required')::boolean,false) or
          not public.application_answer_blank(r.packet->'answers'->(f->>'id')))
        and not public.application_answer_valid(f,r.packet->'answers'->(f->>'id')))
    then return false; end if;
  update public.application_runs set status='queued',approved_packet=packet,
    approved_revision=revision,approved_at=now(),updated_at=now(),message=''
    where id=r.id;
  return true;
end $$;

create or replace function public.retry_application_preparation(p_id uuid) returns boolean language plpgsql security definer set search_path='' as $$
declare r public.application_runs; begin
  select * into r from public.application_runs where id=p_id and user_id=auth.uid() for update;
  if not found or r.status not in ('needs_attention','cancelled') or r.prepare_attempts>=3 or r.receipt is not null
    or exists(select 1 from public.application_events where application_id=r.id and revision>=r.attempt_start_revision
      and status in ('submitting','submitted','submission_unknown')) then return false; end if;
  if not public.reserve_tailoring_attempt() then raise exception 'Daily AI limit reached'; end if;
  update public.application_runs set status='queued_prepare',prepare_attempts=prepare_attempts+1,revision=revision+1,packet=null,approved_packet=null,approved_revision=null,approved_at=null,started_at=null,auto_submit_requested_at=case when r.automatic then now() else null end,message='',updated_at=now() where id=r.id;
  return true;
end $$;

create or replace function public.retry_application_step(p_id uuid, p_revision integer, p_stage text)
returns integer language plpgsql security definer set search_path='' as $$
declare
  r public.application_runs;
  stages text[] := array['load_source','read_employer_form','tailor_resume','validate_packet'];
  position integer := array_position(stages,p_stage);
  next_revision integer;
begin
  if position is null then return null; end if;
  select * into r from public.application_runs
    where id=p_id and user_id=auth.uid() for update;
  if not found or r.revision<>p_revision or r.status<>'needs_attention'
    or r.prepare_attempts>=3 or r.receipt is not null
    or exists(select 1 from public.application_events where application_id=r.id and revision>=r.attempt_start_revision
      and status in ('submitting','submitted','submission_unknown')) then return null; end if;
  if not exists(select 1 from public.application_tasks where application_id=r.id
    and revision=r.revision and stage=p_stage and state in ('blocked','failed')) then return null; end if;
  if exists(select 1 from unnest(stages[1:position-1]) s(stage)
    where not exists(select 1 from public.application_tasks t where t.application_id=r.id
      and t.revision=r.revision and t.stage=s.stage and t.state='completed' and t.output is not null)) then
    raise exception 'Completed step checkpoint unavailable';
  end if;
  if not public.reserve_tailoring_attempt() then raise exception 'Monthly AI limit reached'; end if;
  next_revision := r.revision+1;
  update public.application_runs set
    status='queued_prepare', revision=next_revision, prepare_attempts=prepare_attempts+1,
    packet=null, approved_packet=null, approved_revision=null, approved_at=null,
    auto_submit_requested_at=case when r.automatic then now() else null end, preparation_token=null, started_at=null,
    message=case when r.automatic then 'Retrying the failed step. Auto-apply will continue when preparation finishes.' else 'Retrying the failed preparation step. Completed earlier steps are saved. Review is required before sending.' end, updated_at=now()
    where id=r.id;
  insert into public.application_tasks(application_id,revision,stage,state,attempts,output,message,updated_at)
    select r.id,next_revision,t.stage,'completed',t.attempts,t.output,
      'Reused completed preparation from version '||r.revision||'.',t.updated_at
    from public.application_tasks t where t.application_id=r.id and t.revision=r.revision
      and array_position(stages,t.stage)<position and t.state='completed';
  return next_revision;
end $$;

create or replace function public.queue_application_retry(p_id uuid,p_revision integer,p_stage text,p_error_code text,p_message text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.application_runs; owner_id uuid; next_revision integer; retry_number integer; due timestamptz; note text;
begin
  select user_id into owner_id from public.application_runs where id=p_id;
  if not found then return null; end if;
  perform 1 from public.account_profiles where user_id=owner_id for update;
  select * into r from public.application_runs where id=p_id for update;
  if not found or r.status<>'running' or r.revision<>p_revision or r.receipt is not null
    or r.approved_revision is distinct from r.revision or r.packet is null or r.packet is distinct from r.approved_packet
    or r.automatic_retry_count>=2 or p_stage is null or p_error_code is null or p_stage not in ('check_application','fill_employer_form')
    or p_error_code not in ('captcha_unresolved','temporary_unavailable','rate_limited','invalid_model_response','execution_limit')
    or exists(select 1 from public.application_tasks t where t.application_id=r.id and t.revision>=r.attempt_start_revision and t.stage in ('submit','confirm'))
    or not exists(select 1 from public.application_tasks t where t.application_id=r.id and t.revision=r.revision and t.stage=p_stage)
  then return null; end if;
  next_revision:=r.revision+1;
  retry_number:=r.automatic_retry_count+1;
  due:=clock_timestamp()+case when retry_number=1 then interval '5 minutes' else interval '15 minutes' end;
  note:=left(coalesce(p_message,'A temporary application failure occurred.'),1000)||' Queued for automatic retry '||retry_number||' of 2. Nothing has been submitted.';
  update public.application_tasks set state='failed',error_code=p_error_code,message=note,next_retry_at=null,updated_at=clock_timestamp()
    where application_id=r.id and revision=r.revision and stage=p_stage and state in ('running','blocked','failed');
  update public.application_runs set status='queued',revision=next_revision,approved_revision=next_revision,
    automatic_retry_count=retry_number,retry_after=due,message=note,updated_at=clock_timestamp()
    where id=r.id;
  -- Resume the same approved packet, retaining only completed preparation.
  insert into public.application_tasks(application_id,revision,stage,state,attempts,error_code,message,next_retry_at,output)
    select application_id,next_revision,stage,state,attempts,error_code,message,null,output
    from public.application_tasks where application_id=r.id and revision=r.revision and state='completed'
      and stage in ('load_source','read_employer_form','tailor_resume','validate_packet');
  insert into public.application_tasks(application_id,revision,stage,state,attempts,error_code,message,next_retry_at)
    values(r.id,next_revision,p_stage,'retry_wait',retry_number,p_error_code,note,due);
  -- Carry only the candidate's existing acknowledgement, preserving its expiry.
  insert into public.application_employer_acknowledgements(application_id,revision,conflicting_application_id,user_id,acknowledged_at)
    select application_id,next_revision,conflicting_application_id,user_id,acknowledged_at
    from public.application_employer_acknowledgements where application_id=r.id and revision=r.revision;
  return jsonb_build_object('revision',next_revision,'retryAt',due);
end $$;

create or replace function public.continue_telegram_application(p_thread text,p_application uuid,p_revision integer,p_action text,p_message text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid; r public.application_runs; q public.telegram_requests; prior_sub text; retried boolean; begin
 if p_action is null or p_action not in ('review','retry') or p_message is null or p_revision is null or p_revision<1 then return null; end if;
 select user_id into u from public.telegram_connections where thread_id=p_thread;
 if u is null then return null; end if;
 perform 1 from public.account_profiles where user_id=u for update;
 perform 1 from public.telegram_connections where user_id=u and thread_id=p_thread for update;
 if not found then return null; end if;
 select * into r from public.application_runs where id=p_application and user_id=u for update;
 if not found or r.revision<>p_revision or not r.automatic or r.status not in ('ready','needs_attention') then return null; end if;
 -- No Telegram retry/review can bypass an uncertain or previously attempted send.
 if r.receipt is not null or exists(select 1 from public.application_events where application_id=r.id and revision>=r.attempt_start_revision and status in ('submitting','submitted','submission_unknown')) then return null; end if;
 if p_action='retry' and (r.status<>'needs_attention' or r.prepare_attempts>=3) then return null; end if;
 if p_action='review' and r.packet is null then return null; end if;
 insert into public.telegram_inbound(message_id) values(p_message) on conflict do nothing;
 if not found then return null; end if;
 if p_action='retry' then
  prior_sub:=current_setting('request.jwt.claim.sub',true);
  perform set_config('request.jwt.claim.sub',u::text,true);
  retried:=public.retry_application_preparation(r.id);
  perform set_config('request.jwt.claim.sub',coalesce(prior_sub,''),true);
  if not retried then return null; end if;
  return jsonb_build_object('userId',u,'applicationId',r.id,'action','retry');
 end if;
 select * into q from public.telegram_requests where application_id=r.id and revision=r.revision for update;
 if found and q.status='completed' then return null; end if;
 -- Clear old delivery leases; a concurrent sender must recheck before disclosure.
 update public.telegram_requests set lease_token=null,lease_until=null where user_id=u and status='pending';
 insert into public.telegram_requests(user_id,application_id,revision,packet,state,selected_at)
 values(u,r.id,r.revision,r.packet,jsonb_build_object('answers',r.packet->'answers','confirmed','[]'::jsonb,'initialized',false,'editing',false),clock_timestamp())
 on conflict(application_id,revision) do update set
  state=case when telegram_requests.packet=excluded.packet then jsonb_set(telegram_requests.state,'{editing}','false') else excluded.state end,
  packet=excluded.packet,status='pending',version=telegram_requests.version+1,selected_at=excluded.selected_at,
  expires_at=now()+interval '24 hours',attempts=0,next_attempt_at=now(),delivered_version=0,
  provider_message_id=null,lease_token=null,lease_until=null,last_error=null;
 return jsonb_build_object('userId',u,'applicationId',r.id,'action','review');
end $$;

create or replace function public.transition_telegram_request(p_thread text,p_id uuid,p_version integer,p_state jsonb,p_message text,p_finish boolean default false,p_pause boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
declare q public.telegram_requests; r public.application_runs; u uuid; v integer; previous_sub text; begin
 select user_id into u from public.telegram_connections where thread_id=p_thread;
 if u is null then return null; end if;
 -- Use the review RPC's lock order, including during disconnect and web edits.
 perform 1 from public.account_profiles where user_id=u for update;
 perform 1 from public.telegram_connections where user_id=u and thread_id=p_thread for update;
 if not found then return null; end if;
 select a.* into r from public.application_runs a join public.telegram_requests w on w.application_id=a.id where w.id=p_id and w.user_id=u for update of a;
 select * into q from public.telegram_requests where id=p_id and user_id=u for update;
 if q.id is null or q.status<>'pending' or q.version<>p_version or q.expires_at<=now()
 or r.revision<>q.revision or r.packet is distinct from q.packet or r.status not in ('ready','needs_attention') then return null; end if;
 if q.id is distinct from (select id from public.telegram_requests where user_id=u and status='pending' and expires_at>now() order by selected_at desc nulls last,created_at,id limit 1) then return null; end if;
 if jsonb_typeof(p_state)<>'object' or octet_length(p_state::text)>160000 then raise exception 'Invalid conversation'; end if;
 if p_message is not null then
  insert into public.telegram_inbound(message_id) values(p_message) on conflict do nothing;
  if not found then return null; end if;
 end if;
 if p_finish then
  if r.status='needs_attention' and not r.automatic then return null; end if;
  if exists(select 1 from jsonb_array_elements(r.packet->'fields') f where f->>'kind'<>'resume' and
   ((f->>'required')::boolean or not public.application_answer_blank(p_state->'answers'->(f->>'id')))
   and not public.application_answer_valid(f,p_state->'answers'->(f->>'id'))) then raise exception 'Complete required answers'; end if;
  previous_sub:=current_setting('request.jwt.claim.sub',true);
  perform set_config('request.jwt.claim.sub',u::text,true);
  v:=public.save_application_review(r.id,r.revision,p_state->'answers',r.packet->>'resume','{}'::jsonb,not r.automatic);
  if r.automatic and not public.queue_automatic_application(r.id,v) then
    raise exception 'Application cannot continue automatically';
  end if;
  perform set_config('request.jwt.claim.sub',coalesce(previous_sub,''),true);
 end if;
 update public.telegram_requests set state=p_state,version=version+1,status=case when p_finish then 'completed' when p_pause then 'paused' else 'pending' end,
 lease_token=null,lease_until=null,attempts=0,next_attempt_at=now(),last_error=null,dispatch_revision=v where id=q.id;
 return jsonb_build_object('applicationId',q.application_id,'revision',v);
end $$;

-- Packet edits fence the previous frozen revision, not the user's continuing
-- auto-apply instruction. Missing-question pauses explicitly clear queue intent.
create or replace function public.invalidate_automatic_request() returns trigger
language plpgsql set search_path='' as $$ begin
 if new.status='cancelled' or not new.automatic then new.auto_submit_requested_at:=null; end if;
 return new;
end $$;
