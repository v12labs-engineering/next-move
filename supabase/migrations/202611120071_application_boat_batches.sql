-- One Boat VM per account, with independent leases for live browser attempts.
create table public.application_boat_batches (
  user_id uuid primary key,
  id uuid not null unique,
  sandbox_id text check (sandbox_id ~ '^bx_[a-z0-9]{8}$'),
  access_url text,
  reserved_at timestamptz not null default clock_timestamp(),
  creating_at timestamptz,
  idle_since timestamptz,
  draining boolean not null default false,
  stopping boolean not null default false
);

create table public.application_boat_sessions (
  id uuid primary key,
  batch_id uuid not null references public.application_boat_batches(id) on delete cascade,
  expires_at timestamptz not null
);
create index application_boat_sessions_batch_idx
  on public.application_boat_sessions(batch_id);

alter table public.application_boat_batches enable row level security;
alter table public.application_boat_sessions enable row level security;
revoke all on public.application_boat_batches, public.application_boat_sessions from public, anon, authenticated;
grant select, update, delete on public.application_boat_batches to service_role;

create function public.acquire_application_boat_session(
  p_user_id uuid, p_session_id uuid, p_seconds integer
) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  batch public.application_boat_batches;
  at_time timestamptz;
  expires timestamptz;
begin
  if p_seconds not between 1 and 810 then
    raise exception 'Invalid browser lease length';
  end if;
  insert into public.application_boat_batches (user_id, id)
    values (p_user_id, p_session_id) on conflict (user_id) do nothing;
  select * into batch from public.application_boat_batches
    where user_id=p_user_id for update;
  if not found then return null; end if;
  at_time := clock_timestamp();
  expires := at_time + make_interval(secs => p_seconds);
  -- Leave time for browser cleanup before Boat's 30-minute backstop. The
  -- reservation predates VM creation, so this admission cutoff is conservative.
  if batch.stopping or batch.draining
    or (batch.access_url is null and batch.id<>p_session_id)
  then return null; end if;
  if expires >= batch.reserved_at + interval '29 minutes' then
    update public.application_boat_batches set draining=true where id=batch.id;
    return null;
  end if;

  delete from public.application_boat_sessions
    where batch_id=batch.id and expires_at<=at_time;
  if (select count(*) from public.application_boat_sessions where batch_id=batch.id) >= 2
    and not exists(select 1 from public.application_boat_sessions where id=p_session_id)
  then return null; end if;
  insert into public.application_boat_sessions(id,batch_id,expires_at)
    values (p_session_id,batch.id,expires)
    on conflict(id) do update set expires_at=excluded.expires_at
    returning expires_at into expires;
  update public.application_boat_batches set idle_since=null where id=batch.id;
  return jsonb_build_object(
    'batchId',batch.id,'sandboxId',batch.sandbox_id,'accessUrl',batch.access_url,
    'expiresAt',expires
  );
end;
$$;

create function public.release_application_boat_session(p_batch_id uuid, p_session_id uuid)
returns void
language plpgsql security definer set search_path='' as $$
begin
  perform 1 from public.application_boat_batches where id=p_batch_id for update;
  if not found then return; end if;
  delete from public.application_boat_sessions where batch_id=p_batch_id and id=p_session_id;
  if found and not exists (
    select 1 from public.application_boat_sessions where batch_id=p_batch_id and expires_at>clock_timestamp()
  ) then
    update public.application_boat_batches set idle_since=clock_timestamp() where id=p_batch_id;
  end if;
end;
$$;

create function public.check_application_boat_batch(p_batch_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  batch public.application_boat_batches;
  at_time timestamptz;
  expired_at timestamptz;
  stop_at timestamptz;
begin
  select * into batch from public.application_boat_batches where id=p_batch_id for update;
  if not found then return null; end if;
  at_time := clock_timestamp();
  if not batch.stopping then
    select max(expires_at) into expired_at from public.application_boat_sessions where batch_id=batch.id;
    if expired_at>at_time then
      return jsonb_build_object('checkAt',least(expired_at, at_time + interval '15 seconds'));
    end if;
    batch.idle_since := coalesce(batch.idle_since,expired_at,batch.reserved_at);
    update public.application_boat_batches set idle_since=batch.idle_since where id=batch.id;
    stop_at := case when batch.draining then at_time else batch.idle_since + interval '45 seconds' end;
    -- Keep the VM briefly for work that can reach a browser soon. A stuck
    -- queue, future retry, or unanswered question cannot keep it alive.
    if not batch.draining and batch.access_url is not null and batch.idle_since + interval '90 seconds'>at_time
      and exists (
        select 1 from public.application_runs a where a.user_id=batch.user_id
          and (
            (a.status='queued' and coalesce(a.retry_after, at_time)<=at_time + interval '15 seconds')
            or a.status='running'
            or (a.status='ready' and a.automatic and a.auto_submit_requested_at is not null)
            or (a.status='queued_prepare' and not a.automatic
              and coalesce(a.retry_after, at_time)<=at_time + interval '15 seconds'
              and not exists(select 1 from public.application_tasks t
                where t.application_id=a.id and t.revision=a.revision
                  and t.next_retry_at>at_time + interval '15 seconds'))
          )
      )
    then
      stop_at := greatest(stop_at, least(batch.idle_since + interval '90 seconds', at_time + interval '15 seconds'));
    end if;
    if stop_at>at_time then return jsonb_build_object('checkAt',stop_at); end if;
    update public.application_boat_batches set stopping=true where id=batch.id;
  end if;
  return jsonb_build_object('sandboxId',batch.sandbox_id,'creatingAt',batch.creating_at);
end;
$$;

revoke all on function public.acquire_application_boat_session(uuid,uuid,integer),
  public.release_application_boat_session(uuid,uuid), public.check_application_boat_batch(uuid)
  from public, anon, authenticated;
grant execute on function public.acquire_application_boat_session(uuid,uuid,integer),
  public.release_application_boat_session(uuid,uuid), public.check_application_boat_batch(uuid)
  to service_role;
