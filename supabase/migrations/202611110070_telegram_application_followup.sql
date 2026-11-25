create table public.telegram_followup_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.telegram_connections(user_id) on delete cascade,
  job_id text not null,
  application_id uuid references public.application_runs(id) on delete cascade,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  lease_until timestamptz,
  completed_at timestamptz,
  unique (user_id, job_id)
);
create index telegram_followup_due on public.telegram_followup_notifications (next_attempt_at)
  where completed_at is null and attempts < 5;
alter table public.telegram_followup_notifications enable row level security;
revoke all on public.telegram_followup_notifications from public, anon, authenticated;
grant select, update, delete on public.telegram_followup_notifications to service_role;

create function public.queue_telegram_followup(p_user_id uuid, p_job_id text, p_application_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_job_id is null then return; end if;
  -- Keep a concurrent disconnect from aborting the source transaction.
  perform 1 from public.telegram_connections where user_id = p_user_id for key share;
  if not found then return; end if;
  if p_application_id is null and not exists (
    select 1 from public.recent_manual_followup_jobs(p_user_id) where job_id = p_job_id
  ) then return; end if;

  insert into public.telegram_followup_notifications as n (user_id, job_id, application_id)
  values (p_user_id, p_job_id, p_application_id)
  on conflict (user_id, job_id) do update set
    application_id = excluded.application_id,
    attempts = 0, next_attempt_at = now(), lease_token = null, lease_until = null
  where n.application_id is null and excluded.application_id is not null
    and n.completed_at is null;
end;
$$;

create function public.queue_confirmed_telegram_followup()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'submitted'
    and nullif(btrim(new.receipt->>'text'), '') is not null
    and nullif(btrim(new.receipt->>'confirmedAt'), '') is not null
    and nullif(btrim(new.packet->>'company'), '') is not null then
    if tg_op = 'UPDATE' and old.status = 'submitted' and old.receipt = new.receipt then
      return new;
    end if;
    perform public.queue_telegram_followup(new.user_id, new.job_id, new.id);
  end if;
  return new;
end;
$$;
create trigger application_telegram_followup
  after insert or update of status, receipt on public.application_runs
  for each row execute function public.queue_confirmed_telegram_followup();

create function public.claim_telegram_followup(p_id uuid, p_token uuid)
returns boolean language plpgsql set search_path = '' as $$
begin
  if p_token is null then return false; end if;
  update public.telegram_followup_notifications
  set lease_token = p_token, lease_until = now() + interval '2 minutes', attempts = attempts + 1
  where id = p_id and completed_at is null and attempts < 5
    and next_attempt_at <= now() and (lease_until is null or lease_until <= now());
  return found;
end;
$$;

-- Check the same owner and eligibility before lookup and again before sending.
create function public.telegram_followup_target(p_id uuid, p_token uuid)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'userId', n.user_id, 'jobId', n.job_id, 'applicationId', n.application_id,
    'thread', c.thread_id, 'attempts', n.attempts, 'employer', jsonb_build_object(
      'company', btrim(coalesce(a.packet->>'company', m.job->>'company')),
      'title', coalesce(a.packet->>'title', m.job->>'title', ''),
      'targetUrl', coalesce(a.target_url, m.job->>'url', '')
    )
  )
  from public.telegram_followup_notifications n
  join public.telegram_connections c on c.user_id = n.user_id
  left join public.application_runs a on a.id = n.application_id
    and a.user_id = n.user_id and a.job_id = n.job_id
    and a.status = 'submitted'
    and nullif(btrim(a.receipt->>'text'), '') is not null
    and nullif(btrim(a.receipt->>'confirmedAt'), '') is not null
  left join lateral public.recent_manual_followup_jobs(n.user_id) m
    on n.application_id is null and m.job_id = n.job_id
  where n.id = p_id and n.lease_token = p_token and n.lease_until > now()
    and n.completed_at is null
    and nullif(btrim(coalesce(a.packet->>'company', m.job->>'company')), '') is not null;
$$;

revoke all on function public.queue_telegram_followup(uuid, text, uuid),
  public.queue_confirmed_telegram_followup(),
  public.claim_telegram_followup(uuid, uuid), public.telegram_followup_target(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.queue_telegram_followup(uuid, text, uuid),
  public.claim_telegram_followup(uuid, uuid), public.telegram_followup_target(uuid, uuid)
  to service_role;
