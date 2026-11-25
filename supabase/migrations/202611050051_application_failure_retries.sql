-- Retry only an approved application that demonstrably never entered send intent.
-- A new revision fences delayed writes from the old worker; the packet is retained.
alter table public.application_runs
  add column automatic_retry_count integer not null default 0 check(automatic_retry_count between 0 and 2),
  add column retry_after timestamptz;

create or replace function public.application_queue_turn(p_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.application_runs r where r.id=p_id
    and not exists(select 1 from public.application_runs a
      where a.user_id=r.user_id and a.id<>r.id and
        (a.status in ('preparing','running','submitting') or
         ((a.status in ('queued_prepare','queued') or
           (a.status='ready' and a.auto_submit_requested_at is not null))
          and (a.retry_after is null or a.retry_after<=now())
          and not exists(select 1 from public.application_tasks t
            where t.application_id=a.id and t.revision=a.revision and t.next_retry_at>now())
          and (a.queue_entered_at,a.id)<(r.queue_entered_at,r.id)))))
$$;

create or replace function public.claim_application(p_id uuid,p_revision integer) returns setof public.application_runs
language plpgsql security definer set search_path='' as $$
declare r public.application_runs; owner_id uuid; employer text;
begin
  select user_id into owner_id from public.application_runs where id=p_id;
  if not found then return; end if;
  perform 1 from public.account_profiles where user_id=owner_id for update;
  select * into r from public.application_runs where id=p_id for update;
  if not found or r.status<>'queued' or r.revision<>p_revision or r.retry_after>now()
    or r.approved_revision is distinct from p_revision or r.packet is distinct from r.approved_packet
    or not public.application_queue_turn(r.id) then return; end if;
  employer:=coalesce(r.employer_key,split_part(r.target_url,'/',3));
  if r.approved_at is null or r.approved_at<r.queue_entered_at-interval '30 minutes' or exists(
    select 1 from public.application_runs a where a.user_id=r.user_id and a.id<>r.id
      and coalesce(a.employer_key,split_part(a.target_url,'/',3))=employer
      and (a.status in ('running','submitting') or
        (a.status='submission_unknown' and not (
          employer<>'n8n' and r.job_id is not null and a.job_id is not null
          and r.job_id<>a.job_id and r.target_url<>a.target_url and exists(
            select 1 from public.application_employer_acknowledgements k
            where k.application_id=r.id and k.revision=r.revision
              and k.conflicting_application_id=a.id and k.user_id=r.user_id
              and k.acknowledged_at>now()-interval '30 minutes'
          )
        )) or
        (employer='n8n' and a.status='submitted' and a.updated_at>now()-interval '15 days'))
  ) then
    update public.application_runs set status='needs_attention',message='Another application to this employer has an uncertain result, is inside the employer cooldown, or needs renewed approval. Review before continuing.',updated_at=now() where id=r.id;
    return;
  end if;
  return query update public.application_runs set status='running',retry_after=null,started_at=now(),updated_at=now() where id=r.id returning *;
end $$;

create function public.queue_application_retry(p_id uuid,p_revision integer,p_stage text,p_error_code text,p_message text)
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
    or exists(select 1 from public.application_tasks t where t.application_id=r.id and t.stage in ('submit','confirm'))
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
revoke all on function public.queue_application_retry(uuid,integer,text,text,text) from public,anon,authenticated;
grant execute on function public.queue_application_retry(uuid,integer,text,text,text) to service_role;
