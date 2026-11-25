-- Approval-first application packets. Client roles can read only; all changes
-- pass through owner-derived RPCs. Workers alone can cross the submission boundary.
create table public.application_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  job_id text references public.job_catalog(id),
  target_url text not null,
  status text not null default 'queued_prepare' check(status in ('queued_prepare','preparing','ready','queued','running','submitting','submitted','submission_unknown','needs_attention','cancelled')),
  revision integer not null default 1,
  packet jsonb check(packet is null or (jsonb_typeof(packet)='object' and octet_length(packet::text)<=180000)),
  approved_packet jsonb,
  approved_revision integer,
  approved_at timestamptz,
  message text not null default '',
  receipt jsonb,
  prepare_attempts integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  unique(user_id,target_url),
  check ((approved_packet is null) = (approved_revision is null)),
  check (status not in ('queued','running','submitting','submitted','submission_unknown') or approved_revision=revision),
  check (status<>'submitted' or receipt is not null)
);
create index application_runs_owner_idx on public.application_runs(user_id,updated_at desc);
create table public.application_events (
  id bigint generated always as identity primary key,
  application_id uuid not null references public.application_runs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null,
  revision integer not null,
  created_at timestamptz not null default now()
);
alter table public.application_runs enable row level security;
alter table public.application_events enable row level security;
revoke all on public.application_runs,public.application_events from public,anon,authenticated;
grant select on public.application_runs,public.application_events to authenticated;
grant all on public.application_runs,public.application_events to service_role;
grant usage,select on sequence public.application_events_id_seq to service_role;
create policy application_owner on public.application_runs for select to authenticated using ((select auth.uid())=user_id);
create policy application_event_owner on public.application_events for select to authenticated using ((select auth.uid())=user_id);
create function public.log_application_event() returns trigger language plpgsql security definer set search_path='' as $$ begin
  if TG_OP='INSERT' or new.status<>old.status or new.revision<>old.revision then
    insert into public.application_events(application_id,user_id,status,revision) values(new.id,new.user_id,new.status,new.revision);
  end if;
  return new;
end $$;
create trigger application_event after insert or update on public.application_runs for each row execute function public.log_application_event();

create function public.create_application(p_job text) returns uuid language plpgsql security definer set search_path='' as $$
declare j public.job_catalog; v_id uuid; v_url text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  -- Serialize per account, bounding new browser work before a worker starts.
  perform 1 from public.account_profiles where user_id=auth.uid() for update;
  if not found then raise exception 'Complete your profile'; end if;
  select * into j from public.job_catalog where id=p_job and is_active and last_checked_at>now()-interval '7 days';
  if not found or j.url !~ '^https://jobs\.ashbyhq\.com/[A-Za-z0-9_.-]+/[a-fA-F0-9-]{36}(/application)?/?$' then raise exception 'Unsupported or expired listing'; end if;
  v_url:=regexp_replace(j.url,'(/application)?/?$','')||'/application';
  select id into v_id from public.application_runs where user_id=auth.uid() and target_url=v_url;
  if v_id is not null then return v_id; end if;
  if (select count(*) from public.application_runs where user_id=auth.uid() and created_at>now()-interval '1 day')>=5 then raise exception 'Daily preparation limit reached'; end if;
  if not public.reserve_tailoring_attempt() then raise exception 'Daily AI limit reached'; end if;
  insert into public.application_runs(user_id,job_id,target_url) values(auth.uid(),j.id,v_url) returning id into v_id;
  return v_id;
end $$;
create function public.edit_application(p_id uuid,p_revision integer,p_answers jsonb,p_resume text) returns integer language plpgsql security definer set search_path='' as $$
declare v integer; begin
  if jsonb_typeof(p_answers)<>'object' or octet_length(p_answers::text)>80000 or length(p_resume) not between 30 and 50000 then raise exception 'Invalid packet'; end if;
  update public.application_runs set packet=jsonb_set(jsonb_set(packet,'{answers}',p_answers),'{resume}',to_jsonb(p_resume)),revision=revision+1,
    approved_packet=null,approved_revision=null,approved_at=null,status='ready',message='',updated_at=now()
    where id=p_id and user_id=auth.uid() and revision=p_revision and status in ('ready','queued','needs_attention') and packet is not null returning revision into v;
  if v is null then raise exception 'Application changed; reload before editing' using errcode='P0001'; end if;
  return v;
end $$;
create function public.approve_application(p_id uuid,p_revision integer) returns boolean language plpgsql security definer set search_path='' as $$
declare r public.application_runs;
begin
  select * into r from public.application_runs where id=p_id and user_id=auth.uid() for update;
  if not found or r.revision<>p_revision or r.status<>'ready' or r.packet is null then return false; end if;
  -- Caller also validates typed answers; freeze every field, notice and resume.
  update public.application_runs set status='queued',approved_revision=revision,approved_packet=packet,approved_at=now(),updated_at=now(),message='' where id=r.id;
  return true;
end $$;
create function public.cancel_application(p_id uuid,p_revision integer) returns boolean language plpgsql security definer set search_path='' as $$ begin
  update public.application_runs set status='cancelled',approved_packet=null,approved_revision=null,approved_at=null,updated_at=now()
    where id=p_id and user_id=auth.uid() and revision=p_revision and status in ('queued_prepare','preparing','ready','queued','needs_attention');
  return found;
end $$;
-- Definitive confirmation and the candidate's tracker change commit together.
create function public.confirm_application(p_id uuid,p_revision integer,p_receipt jsonb) returns boolean language plpgsql security definer set search_path='' as $$
declare r public.application_runs; begin
  select * into r from public.application_runs where id=p_id for update;
  if not found or r.status<>'submitting' or r.revision<>p_revision or r.approved_revision<>p_revision or r.packet<>r.approved_packet then return false; end if;
  if nullif(p_receipt->>'text','') is null then raise exception 'Confirmation required'; end if;
  update public.application_runs set status='submitted',receipt=p_receipt,updated_at=now(),message='' where id=r.id;
  if r.job_id is not null then
    insert into public.account_job_states(user_id,job_id,status) values(r.user_id,r.job_id,'applied')
      on conflict(user_id,job_id) do update set status='applied',updated_at=now();
  end if;
  return true;
end $$;
revoke all on function public.create_application(text),public.edit_application(uuid,integer,jsonb,text),public.approve_application(uuid,integer),public.cancel_application(uuid,integer),public.confirm_application(uuid,integer,jsonb),public.log_application_event() from public,anon,authenticated;
grant execute on function public.create_application(text),public.edit_application(uuid,integer,jsonb,text),public.approve_application(uuid,integer),public.cancel_application(uuid,integer) to authenticated;
grant execute on function public.confirm_application(uuid,integer,jsonb) to service_role;
create function public.retry_application_preparation(p_id uuid) returns boolean language plpgsql security definer set search_path='' as $$
declare r public.application_runs; begin
  select * into r from public.application_runs where id=p_id and user_id=auth.uid() for update;
  if not found or r.status not in ('needs_attention','cancelled') or r.prepare_attempts>=3 then return false; end if;
  if not public.reserve_tailoring_attempt() then raise exception 'Daily AI limit reached'; end if;
  update public.application_runs set status='queued_prepare',prepare_attempts=prepare_attempts+1,revision=revision+1,packet=null,approved_packet=null,approved_revision=null,approved_at=null,started_at=null,message='',updated_at=now() where id=r.id;
  return true;
end $$;
revoke all on function public.retry_application_preparation(uuid) from public,anon;
grant execute on function public.retry_application_preparation(uuid) to authenticated;
-- Synthetic employer harness only: no catalogue jobs, no email, service-only.
create table public.application_test_receipts (
  token uuid primary key default gen_random_uuid(),
  application_id uuid not null unique references public.application_runs(id) on delete cascade,
  submissions integer not null default 0 check(submissions between 0 and 1),
  received_at timestamptz
);
alter table public.application_test_receipts enable row level security;
revoke all on public.application_test_receipts from public,anon,authenticated;
grant all on public.application_test_receipts to service_role;
