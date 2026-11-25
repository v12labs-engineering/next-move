-- Retire job sourcing in deployments that still have the old workflow code.
update public.job_source_directory set enabled = false where kind = 'alexandria';
update public.alexandria_search_control set enabled = false where singleton;

create table public.application_followup_lookups (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.application_runs(id) on delete cascade,
  requested_at timestamptz not null default now(),
  contacts jsonb check (jsonb_typeof(contacts) = 'array' and jsonb_array_length(contacts) <= 3)
);
create index application_followup_recent_idx
  on public.application_followup_lookups (application_id, requested_at desc);
alter table public.application_followup_lookups enable row level security;
revoke all on public.application_followup_lookups from public, anon, authenticated;
grant select, update on public.application_followup_lookups to service_role;

create function public.reserve_application_followup(p_id uuid, p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  previous public.application_followup_lookups;
  lookup_id uuid;
begin
  if not exists (
    select 1 from public.application_runs
    where id = p_id and user_id = p_user_id and status = 'submitted'
      and receipt is not null and job_id is not null
  ) then
    return jsonb_build_object('status', 'ineligible');
  end if;

  perform pg_advisory_xact_lock(hashtext('application_followup_lookups'));
  delete from public.application_followup_lookups where requested_at < now() - interval '7 days';

  select * into previous from public.application_followup_lookups
  where application_id = p_id order by requested_at desc limit 1;
  if previous.contacts is not null then
    return jsonb_build_object('status', 'cached', 'contacts', previous.contacts);
  end if;
  if previous.requested_at > now() - interval '10 minutes' then
    return jsonb_build_object('status', 'recent');
  end if;

  -- One request returns up to three records. Reserve before contacting Firecrawl.
  if (select count(*) from public.application_followup_lookups
      where requested_at >= date_trunc('day', now(), 'UTC')) >= 20 then
    return jsonb_build_object('status', 'daily_limit');
  end if;

  insert into public.application_followup_lookups (application_id)
    values (p_id) returning id into lookup_id;
  return jsonb_build_object('status', 'reserved', 'id', lookup_id);
end;
$$;
revoke all on function public.reserve_application_followup(uuid, uuid) from public, anon, authenticated;
grant execute on function public.reserve_application_followup(uuid, uuid) to service_role;
