-- Attention alerts are independent of the one-at-a-time answer review queue.
-- Preparation can stop before a packet exists, or after every answer is known.
create table public.telegram_attention_notifications (
 application_id uuid primary key references public.application_runs(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 revision integer not null,
 version integer not null default 1,
 attempts integer not null default 0,
 next_attempt_at timestamptz not null default now(),
 lease_token uuid,
 lease_until timestamptz,
 delivered_at timestamptz,
 last_error text check(last_error in ('delivery_failed')),
 created_at timestamptz not null default now()
);
create index telegram_attention_due on public.telegram_attention_notifications(next_attempt_at)
 where delivered_at is null and attempts<5;
alter table public.telegram_attention_notifications enable row level security;
revoke all on public.telegram_attention_notifications from public,anon,authenticated;
grant all on public.telegram_attention_notifications to service_role;

create function public.sync_telegram_attention() returns trigger
language plpgsql security definer set search_path='' as $$ begin
 if new.status<>'needs_attention' then
  delete from public.telegram_attention_notifications where application_id=new.id;
  return new;
 end if;
 if TG_OP='UPDATE' and old.status=new.status and old.revision=new.revision
  and old.message is not distinct from new.message then return new; end if;
 insert into public.telegram_attention_notifications(application_id,user_id,revision)
 select new.id,new.user_id,new.revision
 where exists(select 1 from public.telegram_connections where user_id=new.user_id)
 on conflict(application_id) do update set revision=excluded.revision,
  version=telegram_attention_notifications.version+1,attempts=0,next_attempt_at=now(),
  lease_token=null,lease_until=null,delivered_at=null,last_error=null;
 return new;
end $$;
create trigger application_telegram_attention after insert or update of status,revision,message on public.application_runs
 for each row execute function public.sync_telegram_attention();

create function public.sync_telegram_attention_connection() returns trigger
language plpgsql security definer set search_path='' as $$ begin
 if TG_OP='DELETE' then
  delete from public.telegram_attention_notifications where user_id=old.user_id;
  return old;
 end if;
 insert into public.telegram_attention_notifications(application_id,user_id,revision)
 select id,user_id,revision from public.application_runs where user_id=new.user_id and status='needs_attention'
 on conflict(application_id) do update set revision=excluded.revision,
  version=telegram_attention_notifications.version+1,attempts=0,next_attempt_at=now(),
  lease_token=null,lease_until=null,delivered_at=null,last_error=null;
 return new;
end $$;
create trigger telegram_connection_attention after insert or delete on public.telegram_connections
 for each row execute function public.sync_telegram_attention_connection();

create function public.claim_telegram_attention(p_application uuid,p_token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare n public.telegram_attention_notifications; destination text; title text; company text; begin
 if p_token is null then return null; end if;
 select a.* into n from public.telegram_attention_notifications a
 join public.application_runs r on r.id=a.application_id and r.user_id=a.user_id
  and r.status='needs_attention' and r.revision=a.revision
 where a.application_id=p_application and a.delivered_at is null and a.attempts<5
  and a.next_attempt_at<=now() and (a.lease_until is null or a.lease_until<=now())
 for update of a skip locked;
 if not found then return null; end if;
 select c.thread_id into destination from public.telegram_connections c where c.user_id=n.user_id;
 if not found then return null; end if;
 select coalesce(r.packet->>'title',j.title),coalesce(r.packet->>'company',j.company) into title,company
 from public.application_runs r left join public.job_catalog j on j.id=r.job_id where r.id=n.application_id;
 update public.telegram_attention_notifications set lease_token=p_token,lease_until=now()+interval '2 minutes',
  attempts=attempts+1 where application_id=n.application_id;
 return jsonb_build_object('application_id',n.application_id,'version',n.version,
  'attempts',n.attempts+1,'thread_id',destination,'title',title,'company',company);
end $$;
revoke all on function public.sync_telegram_attention(),public.sync_telegram_attention_connection(),public.claim_telegram_attention(uuid,uuid)
 from public,anon,authenticated;
grant execute on function public.claim_telegram_attention(uuid,uuid) to service_role;

-- Backfill the connected account's current failures without modifying packets,
-- approvals, application status, or existing review turns. No messages are sent by SQL.
insert into public.telegram_attention_notifications(application_id,user_id,revision)
 select r.id,r.user_id,r.revision from public.application_runs r
 join public.telegram_connections c on c.user_id=r.user_id where r.status='needs_attention';
