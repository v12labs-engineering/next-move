-- Explicit owner action reopens an uncertain attempt for review, never sending it.
-- Keep prior revision events/tasks for audit and fence late worker callbacks.
create function public.retry_unconfirmed_application(p_id uuid, p_revision integer)
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
    automatic=false, auto_submit_requested_at=null, preparation_token=null,
    started_at=null, decision_attempts=0, automatic_retry_count=0, retry_after=null,
    message='Reopened for retry. Review your saved application and approve another attempt. The previous submission was not confirmed.',
    updated_at=now()
    where id=r.id returning revision into p_revision;
  return p_revision;
end $$;
revoke all on function public.retry_unconfirmed_application(uuid,integer) from public,anon,service_role;
grant execute on function public.retry_unconfirmed_application(uuid,integer) to authenticated;
