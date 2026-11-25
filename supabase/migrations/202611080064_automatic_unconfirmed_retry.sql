-- One extra automatic attempt after an unverifiable send. Apply only to new
-- submitting -> submission_unknown transitions; never resend historical runs.
alter table public.application_runs add column unconfirmed_retry_count integer
  not null default 0 check(unconfirmed_retry_count between 0 and 1);

create function public.retry_unconfirmed_application_once() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if old.status='submitting' and new.status='submission_unknown'
    and old.revision=new.revision and new.automatic
    and new.unconfirmed_retry_count=0 and new.receipt is null
    and new.approved_revision=new.revision and new.packet is not null
    and new.packet=new.approved_packet
    and not exists(select 1 from public.application_tasks t
      where t.application_id=new.id and t.revision=new.revision
        and t.error_code='employer_rejected') then
    -- Keep the failed outcome at its original revision for history and audit.
    insert into public.application_events(application_id,user_id,status,revision)
      values(new.id,new.user_id,'submission_unknown',new.revision);
    new.status:='queued';
    new.revision:=new.revision+1;
    new.attempt_start_revision:=new.revision;
    new.approved_revision:=new.revision;
    new.approved_at:=now();
    new.auto_submit_requested_at:=now();
    new.unconfirmed_retry_count:=1;
    new.automatic_retry_count:=0;
    new.decision_attempts:=0;
    new.started_at:=null;
    new.preparation_token:=null;
    new.retry_after:=clock_timestamp()+interval '15 seconds';
    new.queue_entered_at:=clock_timestamp();
    new.message:='Retrying automatically (1 of 1).';
    new.updated_at:=now();
  elsif new.status='submission_unknown' then
    new.message:='Try again to continue with your saved application.';
  end if;
  return new;
end $$;
revoke all on function public.retry_unconfirmed_application_once() from public,anon,authenticated,service_role;
create trigger application_unconfirmed_retry before update of status on public.application_runs
  for each row execute function public.retry_unconfirmed_application_once();

-- Record the original revision's failed tasks before the trigger queues a new
-- revision. The normal dispatch sweep recovers a lost workflow continuation.
create or replace function public.recover_stale_applications(p_stale interval default interval '15 minutes')
returns integer language plpgsql security definer set search_path='' as $$
declare r public.application_runs; recovered integer:=0;
begin
  for r in select * from public.application_runs
    where (status in ('running','submitting') or (status='preparing' and not automatic))
      and updated_at<now()-p_stale
    for update skip locked
  loop
    update public.application_tasks set state='blocked',
      error_code=case when r.status='submitting' then 'submission_unknown' else 'execution_limit' end,
      message=case when r.status='submitting'
        then 'Try again to continue with your saved application.'
        else 'The worker stopped before finishing this step. Nothing has been submitted.' end,
      next_retry_at=null,updated_at=now()
      where application_id=r.id and revision=r.revision and state='running';
    update public.application_runs set
      status=case when r.status='submitting' then 'submission_unknown' else 'needs_attention' end,
      preparation_token=null,
      message=case when r.status='submitting'
        then 'Try again to continue with your saved application.'
        else 'The application worker stopped before finishing this step. Nothing has been submitted.' end,
      updated_at=now() where id=r.id;
    recovered:=recovered+1;
  end loop;
  return recovered;
end $$;
