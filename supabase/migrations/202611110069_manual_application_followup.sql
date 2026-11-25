alter table public.application_followup_lookups
  alter column application_id drop not null,
  add column manual_user_id uuid,
  add column manual_job_id text,
  add constraint application_followup_manual_job_fk
    foreign key (manual_user_id, manual_job_id)
    references public.account_job_states (user_id, job_id) on delete cascade,
  add constraint application_followup_target_check check (
    (application_id is not null and manual_user_id is null and manual_job_id is null)
    or (application_id is null and manual_user_id is not null and manual_job_id is not null)
  );

create index application_followup_manual_recent_idx
  on public.application_followup_lookups (manual_user_id, manual_job_id, requested_at desc)
  where manual_user_id is not null;

create function public.recent_manual_followup_jobs(p_user_id uuid)
returns table(job_id text, applied_at timestamptz, job jsonb)
language sql stable set search_path = '' as $$
  select s.job_id, s.updated_at, to_jsonb(j) - 'description' - 'description_ref'
  from public.account_job_states s
  join public.job_catalog j on j.id = s.job_id
  where s.user_id = p_user_id and s.status = 'applied'
    and not exists (
      select 1 from public.application_runs a
      where a.user_id = s.user_id and a.job_id = s.job_id
        and a.status = 'submitted' and a.receipt is not null
    )
  order by s.updated_at desc, s.job_id
  limit 5;
$$;

-- Both entry points share the existing daily budget and cache lifetime.
create function public.reserve_followup_lookup(
  p_application_id uuid, p_manual_user_id uuid, p_manual_job_id text
)
returns jsonb language plpgsql set search_path = '' as $$
declare
  previous public.application_followup_lookups;
  lookup_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('application_followup_lookups'));
  delete from public.application_followup_lookups where requested_at < now() - interval '7 days';

  select * into previous from public.application_followup_lookups
  where application_id = p_application_id
    or (manual_user_id = p_manual_user_id and manual_job_id = p_manual_job_id)
  order by requested_at desc limit 1;
  if previous.contacts is not null then
    return jsonb_build_object('status', 'cached', 'contacts', previous.contacts);
  end if;
  if previous.requested_at > now() - interval '10 minutes' then
    return jsonb_build_object('status', 'recent');
  end if;

  if (select count(*) from public.application_followup_lookups
      where requested_at >= date_trunc('day', now(), 'UTC')) >= 20 then
    return jsonb_build_object('status', 'daily_limit');
  end if;

  insert into public.application_followup_lookups (application_id, manual_user_id, manual_job_id)
    values (p_application_id, p_manual_user_id, p_manual_job_id) returning id into lookup_id;
  return jsonb_build_object('status', 'reserved', 'id', lookup_id);
end;
$$;

create or replace function public.reserve_application_followup(p_id uuid, p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.application_runs
    where id = p_id and user_id = p_user_id and status = 'submitted'
      and receipt is not null and job_id is not null
  ) then
    return jsonb_build_object('status', 'ineligible');
  end if;
  return public.reserve_followup_lookup(p_id, null, null);
end;
$$;

create function public.reserve_manual_application_followup(p_job_id text, p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  employer jsonb;
  reservation jsonb;
begin
  select jsonb_build_object(
    'company', btrim(recent.job->>'company'), 'title', recent.job->>'title', 'targetUrl', recent.job->>'url'
  )
  into employer
  from public.recent_manual_followup_jobs(p_user_id) recent
  where recent.job_id = p_job_id and nullif(btrim(recent.job->>'company'), '') is not null;
  if employer is null then
    return jsonb_build_object('status', 'ineligible');
  end if;

  reservation := public.reserve_followup_lookup(null, p_user_id, p_job_id);
  if reservation->>'status' = 'reserved' then
    return reservation || jsonb_build_object('employer', employer);
  end if;
  return reservation;
end;
$$;

revoke all on function public.reserve_followup_lookup(uuid, uuid, text),
  public.recent_manual_followup_jobs(uuid), public.reserve_manual_application_followup(text, uuid)
  from public, anon, authenticated;
revoke all on function public.reserve_followup_lookup(uuid, uuid, text) from service_role;
grant execute on function public.recent_manual_followup_jobs(uuid),
  public.reserve_manual_application_followup(text, uuid) to service_role;
