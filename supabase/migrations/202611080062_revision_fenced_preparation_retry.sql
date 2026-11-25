-- The HTTP retry action carries the revision the candidate actually reviewed.
-- Lock that owned revision before delegating the existing quota/send guards.
-- Keep the legacy function for Telegram and older clients during deployment.
create function public.retry_application_preparation_revision(p_id uuid, p_revision integer)
returns boolean language plpgsql security definer set search_path='' as $$
declare r public.application_runs;
begin
  select * into r from public.application_runs
    where id=p_id and user_id=auth.uid() for update;
  if not found or p_revision is null or r.revision<>p_revision then return false; end if;
  return public.retry_application_preparation(p_id);
end $$;
revoke all on function public.retry_application_preparation_revision(uuid,integer) from public,anon;
grant execute on function public.retry_application_preparation_revision(uuid,integer) to authenticated;
