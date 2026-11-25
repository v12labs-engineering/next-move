-- Visual application loops need more decisions than link-only discovery.
-- Every model turn still reserves the account's existing monthly AI quota.
-- This changes only the per-revision ceiling; plan prices/limits are unchanged.
alter table public.application_runs drop constraint application_runs_decision_attempts_check;
alter table public.application_runs add constraint application_runs_decision_attempts_check check (decision_attempts between 0 and 32);
create or replace function public.reserve_application_decision(p_id uuid) returns boolean language plpgsql security definer set search_path='' as $$
declare r public.application_runs;
begin
  select * into r from public.application_runs where id = p_id for update;
  if not found or r.status not in ('preparing', 'running') or r.decision_attempts >= 32 then return false; end if;
  if not public.reserve_ai_attempt(r.user_id) then return false; end if;
  update public.application_runs set decision_attempts = decision_attempts + 1 where id = r.id;
  return true;
end $$;
revoke all on function public.reserve_application_decision(uuid) from public, anon, authenticated;
grant execute on function public.reserve_application_decision(uuid) to service_role;
