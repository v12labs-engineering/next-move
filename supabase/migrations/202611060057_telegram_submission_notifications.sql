-- Queue confirmation in the same transaction that persists the employer receipt.
-- Existing submissions are not backfilled; reconnecting does not replay history.
create table public.telegram_submission_notifications (
 application_id uuid primary key references public.application_runs(id) on delete cascade,
 user_id uuid not null references public.telegram_connections(user_id) on delete cascade,
 revision integer not null,
 attempts integer not null default 0,
 next_attempt_at timestamptz not null default now(),
 lease_token uuid,
 lease_until timestamptz,
 delivered_at timestamptz,
 provider_message_id text,
 last_error text check(last_error in ('delivery_failed')),
 created_at timestamptz not null default now()
);
create index telegram_submission_due on public.telegram_submission_notifications(next_attempt_at)
 where delivered_at is null and attempts<5;
alter table public.telegram_submission_notifications enable row level security;
revoke all on public.telegram_submission_notifications from public,anon,authenticated;
grant all on public.telegram_submission_notifications to service_role;

create function public.sync_telegram_submission() returns trigger
language plpgsql security definer set search_path='' as $$ begin
 if new.status<>'submitted' or jsonb_typeof(new.receipt->'text') is distinct from 'string'
  or nullif(btrim(new.receipt->>'text'),'') is null
  or jsonb_typeof(new.receipt->'confirmedAt') is distinct from 'string'
  or nullif(btrim(new.receipt->>'confirmedAt'),'') is null then
  delete from public.telegram_submission_notifications where application_id=new.id and delivered_at is null;
  return new;
 end if;
 if TG_OP='UPDATE' and old.status='submitted' and old.receipt is not null then return new; end if;
 -- Hold the connection through insertion so a concurrent disconnect cannot
 -- cause an FK error that rolls back the employer receipt.
 perform 1 from public.telegram_connections where user_id=new.user_id for key share;
 if not found then return new; end if;
 insert into public.telegram_submission_notifications(application_id,user_id,revision)
 values(new.id,new.user_id,new.revision)
 on conflict(application_id) do nothing;
 return new;
end $$;
create trigger application_telegram_submission after insert or update of status,receipt,revision on public.application_runs
 for each row execute function public.sync_telegram_submission();

create function public.claim_telegram_submission(p_application uuid,p_token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare n public.telegram_submission_notifications; destination text; title text; company text; begin
 if p_token is null then return null; end if;
 select a.* into n from public.telegram_submission_notifications a
 join public.application_runs r on r.id=a.application_id and r.user_id=a.user_id
  and r.status='submitted' and r.revision=a.revision
 where a.application_id=p_application and a.delivered_at is null and a.attempts<5
  and a.next_attempt_at<=now() and (a.lease_until is null or a.lease_until<=now())
 for update of a skip locked;
 if not found then return null; end if;
 select c.thread_id into destination from public.telegram_connections c where c.user_id=n.user_id;
 if not found then return null; end if;
 select coalesce(r.packet->>'title',j.title),coalesce(r.packet->>'company',j.company) into title,company
 from public.application_runs r left join public.job_catalog j on j.id=r.job_id where r.id=n.application_id;
 update public.telegram_submission_notifications set lease_token=p_token,lease_until=now()+interval '2 minutes',
  attempts=attempts+1 where application_id=n.application_id;
 return jsonb_build_object('application_id',n.application_id,'revision',n.revision,
  'attempts',n.attempts+1,'thread_id',destination,'title',title,'company',company);
end $$;
revoke all on function public.sync_telegram_submission(),public.claim_telegram_submission(uuid,uuid)
 from public,anon,authenticated;
grant execute on function public.claim_telegram_submission(uuid,uuid) to service_role;
