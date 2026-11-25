-- Match Browser Use max_steps=45, including post-submit CAPTCHA and receipt turns.
-- Preserve monthly quotas, approval fencing, and terminal-state exclusions.
create or replace function public.reserve_application_decision(p_id uuid) returns boolean language plpgsql security definer set search_path='' as $$
declare r public.application_runs;
begin
  select * into r from public.application_runs where id = p_id for update;
  if not found or r.status not in ('preparing', 'running', 'submitting') or r.decision_attempts >= 45 then return false; end if;
  if r.status = 'submitting' and r.approved_revision is distinct from r.revision then return false; end if;
  if not public.reserve_ai_attempt(r.user_id) then return false; end if;
  update public.application_runs set decision_attempts = decision_attempts + 1 where id = r.id;
  return true;
end $$;
revoke all on function public.reserve_application_decision(uuid) from public, anon, authenticated;
grant execute on function public.reserve_application_decision(uuid) to service_role;
