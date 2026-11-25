-- A worker killed at its execution limit never reaches its own failure write.
-- Runs left in an active state past any possible worker lifetime are stopped:
-- before sending they need attention; after sending began the outcome is unknown.
create function public.recover_stale_applications(p_stale interval default interval '15 minutes')
returns integer language plpgsql security definer set search_path='' as $$
declare recovered integer; begin
 with stale as (
  update public.application_runs set
   status=case when status='submitting' then 'submission_unknown' else 'needs_attention' end,
   preparation_token=null,
   message=case when status='submitting'
    then 'Sending started but the worker stopped before the employer receipt was verified. Check with the employer before applying again; automatic resubmission is blocked.'
    else 'The application worker stopped before finishing this step. Nothing has been submitted.' end,
   updated_at=now()
  -- Automatic preparation is resumed by recover_application_preparation instead.
  where (status in ('running','submitting') or (status='preparing' and not automatic))
   and updated_at<now()-p_stale
  returning id,revision,status
 ), tasks as (
  update public.application_tasks t set
   state='blocked',
   error_code=case when s.status='submission_unknown' then 'submission_unknown' else 'execution_limit' end,
   message=case when s.status='submission_unknown'
    then 'Sending started; automatic resubmission is blocked.'
    else 'The worker stopped before finishing this step. Nothing has been submitted.' end,
   next_retry_at=null,
   updated_at=now()
  from stale s where t.application_id=s.id and t.revision=s.revision and t.state='running'
 )
 select count(*) into recovered from stale;
 return recovered;
end $$;
revoke all on function public.recover_stale_applications(interval) from public,anon,authenticated;
grant execute on function public.recover_stale_applications(interval) to service_role;
