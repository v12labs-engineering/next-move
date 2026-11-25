-- Telegram is a second review surface. Application packets and receipts remain
-- authoritative; service-only transitions bind replies to an exact snapshot.
create table public.telegram_links (
 user_id uuid primary key references auth.users(id) on delete cascade,
 token_hash text not null unique check(token_hash ~ '^[a-f0-9]{64}$'),
 expires_at timestamptz not null default now()+interval '10 minutes',
 created_at timestamptz not null default now(),
 pending_thread text,
 pending_label text
);
create table public.telegram_connections (
 user_id uuid primary key references auth.users(id) on delete cascade,
 thread_id text not null unique,
 label text not null,
 last_inbound_at timestamptz not null default now()-interval '10 minutes',
 connected_at timestamptz not null default now()
);
create table public.telegram_requests (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 application_id uuid not null references public.application_runs(id) on delete cascade,
 revision integer not null,
 packet jsonb not null,
 state jsonb not null,
 version integer not null default 1,
 status text not null default 'pending' check(status in ('pending','completed','paused','expired')),
 expires_at timestamptz not null default now()+interval '24 hours',
 created_at timestamptz not null default now(),
 delivered_version integer not null default 0,
 attempts integer not null default 0,
 next_attempt_at timestamptz not null default now(),
 lease_token uuid,
 lease_until timestamptz,
 last_error text check(last_error in ('delivery_failed')),
 dispatch_revision integer,
 dispatched_at timestamptz,
 provider_message_id text,
 unique(application_id,revision)
);
create index telegram_requests_pending on public.telegram_requests(user_id,created_at) where status='pending';
-- Durable inbound receipts prevent webhook replay from advancing another turn.
create table public.telegram_inbound (
 message_id text primary key,
 received_at timestamptz not null default now()
);
alter table public.telegram_links enable row level security;
alter table public.telegram_connections enable row level security;
alter table public.telegram_requests enable row level security;
alter table public.telegram_inbound enable row level security;
revoke all on public.telegram_links,public.telegram_connections,public.telegram_requests,public.telegram_inbound from public,anon,authenticated;
grant select on public.telegram_connections to authenticated;
grant all on public.telegram_links,public.telegram_connections,public.telegram_requests,public.telegram_inbound to service_role;
create policy telegram_connection_owner on public.telegram_connections for select to authenticated using(user_id=(select auth.uid()));

create function public.enqueue_telegram_requests(p_user uuid) returns void
language sql security definer set search_path='' as $$
 insert into public.telegram_requests(user_id,application_id,revision,packet,state)
 select r.user_id,r.id,r.revision,r.packet,jsonb_build_object('answers',r.packet->'answers','confirmed','[]'::jsonb,'initialized',false,'editing',false)
 from public.application_runs r join public.telegram_connections c on c.user_id=r.user_id
 where r.user_id=p_user and r.packet is not null and
 (r.status='ready' and (r.auto_submit_requested_at is null or r.auto_submit_requested_at<=now()-interval '30 minutes') or r.status in ('ready','needs_attention') and exists(
 select 1 from jsonb_array_elements(r.packet->'fields') f where f->>'kind'<>'resume' and
 ((f->>'required')::boolean and not public.application_answer_valid(f,r.packet->'answers'->(f->>'id')))))
 on conflict(application_id,revision) do update set packet=excluded.packet,state=excluded.state,status='pending',version=telegram_requests.version+1,
 expires_at=now()+interval '24 hours',attempts=0,next_attempt_at=now(),lease_token=null,lease_until=null
 where telegram_requests.packet is distinct from excluded.packet or telegram_requests.status='expired'
$$;

create function public.sync_telegram_application() returns trigger
language plpgsql security definer set search_path='' as $$ begin
 update public.telegram_requests set status='expired',lease_token=null,lease_until=null
 where application_id=new.id and status='pending' and
 (revision<>new.revision or packet is distinct from new.packet or new.status not in ('ready','needs_attention'));
 if new.status in ('ready','needs_attention') then perform public.enqueue_telegram_requests(new.user_id); end if;
 return new;
end $$;
create trigger application_telegram after insert or update of status,revision,packet on public.application_runs
for each row execute function public.sync_telegram_application();

create function public.begin_telegram_link(p_hash text) returns void
language plpgsql security definer set search_path='' as $$ begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 perform 1 from public.account_profiles where user_id=auth.uid() for update;
 if not found then raise exception 'Complete your profile'; end if;
 if exists(select 1 from public.telegram_links where user_id=auth.uid() and created_at>now()-interval '1 minute') then raise exception 'Wait a minute before requesting another link'; end if;
 insert into public.telegram_links(user_id,token_hash) values(auth.uid(),p_hash)
 on conflict(user_id) do update set token_hash=excluded.token_hash,created_at=now(),expires_at=excluded.expires_at,pending_thread=null,pending_label=null;
end $$;
create function public.telegram_link_status() returns jsonb
language sql stable security definer set search_path='' as $$
 select coalesce((select jsonb_build_object('label',pending_label,'expiresAt',expires_at) from public.telegram_links where user_id=auth.uid() and expires_at>now()),'null'::jsonb)
$$;
create function public.claim_telegram_link(p_hash text,p_thread text,p_label text) returns boolean
language plpgsql security definer set search_path='' as $$ begin
 if length(p_thread)>300 or p_thread !~ '^telegram:[1-9][0-9]*$' or length(p_label)>200 then return false; end if;
 update public.telegram_links set pending_thread=p_thread,pending_label=p_label
 where token_hash=p_hash and expires_at>now() and pending_thread is null;
 return found;
end $$;
create function public.confirm_telegram_link() returns boolean
language plpgsql security definer set search_path='' as $$
declare l public.telegram_links; begin
 perform 1 from public.account_profiles where user_id=auth.uid() for update;
 select * into l from public.telegram_links where user_id=auth.uid() and expires_at>now() and pending_thread is not null for update;
 if not found then return false; end if;
 -- Expire old buttons before changing identity. Committed send intent survives.
 update public.telegram_requests set status='expired',lease_token=null,lease_until=null where user_id=auth.uid() and status='pending';
 delete from public.telegram_connections where user_id=auth.uid();
 insert into public.telegram_connections(user_id,thread_id,label) values(auth.uid(),l.pending_thread,l.pending_label);
 delete from public.telegram_links where user_id=auth.uid();
 perform public.enqueue_telegram_requests(auth.uid());
 return true;
end $$;
create function public.disconnect_telegram() returns void
language plpgsql security definer set search_path='' as $$ begin
 perform 1 from public.account_profiles where user_id=auth.uid() for update;
 update public.telegram_requests set status='expired',lease_token=null,lease_until=null where user_id=auth.uid() and status='pending';
 delete from public.telegram_connections where user_id=auth.uid();
 delete from public.telegram_links where user_id=auth.uid();
end $$;
create function public.stop_telegram(p_thread text) returns void
language plpgsql security definer set search_path='' as $$ declare u uuid; begin
 select user_id into u from public.telegram_connections where thread_id=p_thread;
 perform 1 from public.account_profiles where user_id=u for update;
 update public.telegram_requests set status='expired',lease_token=null,lease_until=null where user_id=u and status='pending';
 delete from public.telegram_connections where user_id=u and thread_id=p_thread;
 delete from public.telegram_links where user_id=u or pending_thread=p_thread;
end $$;
revoke all on function public.stop_telegram(text) from public,anon,authenticated;
grant execute on function public.stop_telegram(text) to service_role;

-- Serialize deliveries per account and recover abandoned leases. Sending can be
-- at least once; a duplicate card keeps the same version and is harmless.
create function public.claim_telegram_delivery(p_user uuid,p_token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare q public.telegram_requests; c public.telegram_connections; begin
 select * into c from public.telegram_connections where user_id=p_user for update;
 if not found then return null; end if;
 update public.telegram_requests set status='expired' where user_id=p_user and status='pending' and expires_at<=now();
 select * into q from public.telegram_requests where user_id=p_user and status='pending' order by created_at,id limit 1 for update;
 if not found or q.delivered_version=q.version or q.next_attempt_at>now() or q.lease_until>now() or q.attempts>=5 then return null; end if;
 update public.telegram_requests set lease_token=p_token,lease_until=now()+interval '2 minutes',attempts=attempts+1 where id=q.id;
 return to_jsonb(q)||jsonb_build_object('thread_id',c.thread_id,'last_inbound_at',c.last_inbound_at);
end $$;
create function public.fail_telegram_delivery(p_message text) returns void
language sql security definer set search_path='' as $$
 update public.telegram_requests set delivered_version=0,last_error='delivery_failed',next_attempt_at=now()+interval '5 minutes',
 status=case when attempts>=5 then 'paused' else 'pending' end
 where provider_message_id=p_message and status='pending'
$$;
revoke all on function public.fail_telegram_delivery(text) from public,anon,authenticated;
grant execute on function public.fail_telegram_delivery(text) to service_role;

create function public.transition_telegram_request(p_thread text,p_id uuid,p_version integer,p_state jsonb,p_message text,p_finish boolean default false,p_pause boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
declare q public.telegram_requests; r public.application_runs; u uuid; v integer; previous_sub text; begin
 select user_id into u from public.telegram_connections where thread_id=p_thread;
 if u is null then return null; end if;
 -- Use the review RPC's lock order, including during disconnect and web edits.
 perform 1 from public.account_profiles where user_id=u for update;
 perform 1 from public.telegram_connections where user_id=u and thread_id=p_thread for update;
 if not found then return null; end if;
 select a.* into r from public.application_runs a join public.telegram_requests w on w.application_id=a.id where w.id=p_id and w.user_id=u for update of a;
 select * into q from public.telegram_requests where id=p_id and user_id=u for update;
 if q.id is null or q.status<>'pending' or q.version<>p_version or q.expires_at<=now()
 or r.revision<>q.revision or r.packet is distinct from q.packet or r.status not in ('ready','needs_attention') then return null; end if;
 if exists(select 1 from public.telegram_requests where user_id=u and status='pending' and expires_at>now() and (created_at,id)<(q.created_at,q.id)) then return null; end if;
 if jsonb_typeof(p_state)<>'object' or octet_length(p_state::text)>160000 then raise exception 'Invalid conversation'; end if;
 if p_message is not null then
  insert into public.telegram_inbound(message_id) values(p_message) on conflict do nothing;
  if not found then return null; end if;
 end if;
 if p_finish then
  if r.status='needs_attention' and not r.automatic then return null; end if;
  if exists(select 1 from jsonb_array_elements(r.packet->'fields') f where f->>'kind'<>'resume' and
   ((f->>'required')::boolean or not public.application_answer_blank(p_state->'answers'->(f->>'id')))
   and not public.application_answer_valid(f,p_state->'answers'->(f->>'id'))) then raise exception 'Complete required answers'; end if;
  previous_sub:=current_setting('request.jwt.claim.sub',true);
  perform set_config('request.jwt.claim.sub',u::text,true);
  v:=public.save_application_review(r.id,r.revision,p_state->'answers',r.packet->>'resume','{}'::jsonb,true);
  perform set_config('request.jwt.claim.sub',coalesce(previous_sub,''),true);
 end if;
 update public.telegram_requests set state=p_state,version=version+1,status=case when p_finish then 'completed' when p_pause then 'paused' else 'pending' end,
 lease_token=null,lease_until=null,attempts=0,next_attempt_at=now(),last_error=null,dispatch_revision=v where id=q.id;
 return jsonb_build_object('applicationId',q.application_id,'revision',v);
end $$;

revoke all on function public.enqueue_telegram_requests(uuid),public.sync_telegram_application(),public.begin_telegram_link(text),public.telegram_link_status(),public.claim_telegram_link(text,text,text),public.confirm_telegram_link(),public.disconnect_telegram(),public.claim_telegram_delivery(uuid,uuid),public.transition_telegram_request(text,uuid,integer,jsonb,text,boolean,boolean) from public,anon,authenticated;
grant execute on function public.begin_telegram_link(text),public.telegram_link_status(),public.confirm_telegram_link(),public.disconnect_telegram() to authenticated;
grant execute on function public.enqueue_telegram_requests(uuid),public.claim_telegram_link(text,text,text),public.claim_telegram_delivery(uuid,uuid),public.transition_telegram_request(text,uuid,integer,jsonb,text,boolean,boolean) to service_role;
