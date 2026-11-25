-- One budgeted AI drafting attempt per Telegram review request. The existing
-- notification lease and snapshot/version checks fence concurrent delivery.
alter table public.telegram_requests add column ai_draft_attempted boolean not null default false;
create function public.reserve_telegram_ai_draft(p_id uuid,p_version integer,p_token uuid) returns text
language plpgsql security definer set search_path='' as $$
declare q public.telegram_requests; r public.application_runs; u uuid; begin
 select user_id into u from public.telegram_requests where id=p_id;
 if u is null then return 'stale'; end if;
 perform 1 from public.account_profiles where user_id=u for update;
 select a.* into r from public.application_runs a join public.telegram_requests t on t.application_id=a.id where t.id=p_id for update of a;
 select * into q from public.telegram_requests where id=p_id for update;
 if q.id is null or q.status<>'pending' or q.version<>p_version or q.ai_draft_attempted
 or q.expires_at<=now() or p_token is null or q.lease_token is distinct from p_token or q.lease_until is null or q.lease_until<=now()
 or r.status not in ('ready','needs_attention') or r.revision<>q.revision or r.packet is distinct from q.packet
 or not exists(select 1 from public.telegram_connections where user_id=u) then return 'stale'; end if;
 update public.telegram_requests set ai_draft_attempted=true where id=q.id;
 if not public.reserve_ai_attempt(u) then return 'allowance'; end if;
 return 'reserved';
end $$;
revoke all on function public.reserve_telegram_ai_draft(uuid,integer,uuid) from public,anon,authenticated;
grant execute on function public.reserve_telegram_ai_draft(uuid,integer,uuid) to service_role;
