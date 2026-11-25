-- Plan limits are data so tiers and numbers change without a deploy. Usage is
-- measured over a rolling 30 days. Accounts without a row are on 'free'.
create table public.plans (
  id text primary key,
  monthly_applications integer not null check (monthly_applications >= 0),
  monthly_ai_requests integer not null check (monthly_ai_requests >= 0)
);
insert into public.plans values ('free', 10, 30);
create table public.account_plans (
  user_id uuid primary key references auth.users(id) on delete cascade,
  plan text not null references public.plans(id),
  updated_at timestamptz not null default now()
);
alter table public.plans enable row level security;
alter table public.account_plans enable row level security;
revoke all on public.plans, public.account_plans from anon, authenticated;
grant select on public.plans, public.account_plans to authenticated;
grant all on public.plans, public.account_plans to service_role;
create policy plans_read on public.plans for select to authenticated using (true);
create policy plan_owner on public.account_plans for select to authenticated using ((select auth.uid()) = user_id);

create function public.account_limits(p_user uuid) returns public.plans language sql stable security definer set search_path='' as $$
  select p.* from public.plans p
  where p.id = coalesce((select plan from public.account_plans where user_id = p_user), 'free')
$$;
revoke all on function public.account_limits(uuid) from public, anon, authenticated;

-- Serialized per account so concurrent requests cannot overspend the plan.
create function public.reserve_ai_attempt(p_user uuid) returns boolean language plpgsql security definer set search_path='' as $$
declare v_used integer;
begin
  perform pg_advisory_xact_lock(hashtext('ai:' || p_user::text));
  select coalesce(sum(attempts), 0) into v_used from public.account_ai_usage
  where user_id = p_user and day > (now() at time zone 'UTC')::date - 30;
  if v_used >= (public.account_limits(p_user)).monthly_ai_requests then return false; end if;
  insert into public.account_ai_usage(user_id, day, attempts) values (p_user, (now() at time zone 'UTC')::date, 1)
  on conflict (user_id, day) do update set attempts = public.account_ai_usage.attempts + 1;
  return true;
end $$;
revoke all on function public.reserve_ai_attempt(uuid) from public, anon, authenticated;

create or replace function public.reserve_tailoring_attempt() returns boolean language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  return public.reserve_ai_attempt(auth.uid());
end $$;
revoke all on function public.reserve_tailoring_attempt() from public, anon;
grant execute on function public.reserve_tailoring_attempt() to authenticated;

create or replace function public.reserve_application_decision(p_id uuid) returns boolean language plpgsql security definer set search_path='' as $$
declare r public.application_runs;
begin
  select * into r from public.application_runs where id = p_id for update;
  if not found or r.status not in ('preparing', 'running') or r.decision_attempts >= 6 then return false; end if;
  if not public.reserve_ai_attempt(r.user_id) then return false; end if;
  update public.application_runs set decision_attempts = decision_attempts + 1 where id = r.id;
  return true;
end $$;
revoke all on function public.reserve_application_decision(uuid) from public, anon, authenticated;
grant execute on function public.reserve_application_decision(uuid) to service_role;

-- The account-explicit form serves the background runner; the session form
-- below keeps the existing contract for signed-in requests.
create function public.create_application_for(p_user uuid, p_job text) returns uuid language plpgsql security definer set search_path='' as $$
declare j public.job_catalog; v_id uuid; v_url text;
begin
  perform 1 from public.account_profiles where user_id = p_user for update;
  if not found then raise exception 'Complete your profile'; end if;
  select * into j from public.job_catalog where id = p_job and is_active and last_checked_at > now() - interval '7 days';
  if not found then raise exception 'Unsupported or expired listing'; end if;
  v_url := public.application_target(j.url);
  if v_url is null then raise exception 'A public HTTPS listing is required'; end if;
  select id into v_id from public.application_runs where user_id = p_user and (job_id = j.id or target_url = v_url) order by (job_id = j.id) desc limit 1;
  if v_id is not null then return v_id; end if;
  if (select count(*) from public.application_runs where user_id = p_user and created_at > now() - interval '30 days')
    >= (public.account_limits(p_user)).monthly_applications then
    raise exception 'Monthly application limit reached';
  end if;
  if not public.reserve_ai_attempt(p_user) then raise exception 'Monthly AI limit reached'; end if;
  insert into public.application_runs(user_id, job_id, target_url, employer_key)
  values (p_user, j.id, v_url, coalesce(nullif(lower(btrim(j.company)), ''), split_part(v_url, '/', 3))) returning id into v_id;
  return v_id;
end $$;
revoke all on function public.create_application_for(uuid, text) from public, anon, authenticated;

create or replace function public.create_application(p_job text) returns uuid language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  return public.create_application_for(auth.uid(), p_job);
end $$;

create function public.request_automatic_application_for(p_user uuid, p_job text) returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid; begin
  v_id := public.create_application_for(p_user, p_job);
  update public.application_runs set auto_submit_requested_at = now(), automatic = true, updated_at = now()
  where id = v_id and user_id = p_user and status in ('queued_prepare', 'ready');
  return v_id;
end $$;
revoke all on function public.request_automatic_application_for(uuid, text) from public, anon, authenticated;
grant execute on function public.request_automatic_application_for(uuid, text) to service_role;

create or replace function public.request_automatic_application(p_job text) returns uuid language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  return public.request_automatic_application_for(auth.uid(), p_job);
end $$;

create function public.account_usage() returns table (
  plan text, applications_used integer, applications_limit integer, ai_used integer, ai_limit integer
) language sql stable security definer set search_path='' as $$
  select l.id,
    (select count(*)::integer from public.application_runs where user_id = auth.uid() and created_at > now() - interval '30 days'),
    l.monthly_applications,
    (select coalesce(sum(attempts), 0)::integer from public.account_ai_usage where user_id = auth.uid() and day > (now() at time zone 'UTC')::date - 30),
    l.monthly_ai_requests
  from public.account_limits(auth.uid()) l
  where auth.uid() is not null
$$;
revoke all on function public.account_usage() from public, anon;
grant execute on function public.account_usage() to authenticated;

-- Background runs select opted-in accounts without scanning every profile.
create index account_profiles_auto_apply_idx on public.account_profiles(user_id)
where (data -> 'autoApply' ->> 'enabled') = 'true';
