-- Retry failed preparation from an owned, exact revision. Upstream checkpoint
-- outputs stay service-only; no employer action is dispatched by this function.
create function public.retry_application_step(p_id uuid, p_revision integer, p_stage text)
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
    or r.prepare_attempts>=3 or r.receipt is not null then return null; end if;
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
    auto_submit_requested_at=null, preparation_token=null, started_at=null,
    message='Retrying the failed preparation step. Completed earlier steps are saved. Review is required before sending.', updated_at=now()
    where id=r.id;
  insert into public.application_tasks(application_id,revision,stage,state,attempts,output,message,updated_at)
    select r.id,next_revision,t.stage,'completed',t.attempts,t.output,
      'Reused completed preparation from version '||r.revision||'.',t.updated_at
    from public.application_tasks t where t.application_id=r.id and t.revision=r.revision
      and array_position(stages,t.stage)<position and t.state='completed';
  return next_revision;
end $$;
revoke all on function public.retry_application_step(uuid,integer,text) from public,anon,service_role;
grant execute on function public.retry_application_step(uuid,integer,text) to authenticated;
