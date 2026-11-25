-- Selecting an alert changes the current review, not its answers or approval.
-- This migration is independent of the separate account-queue migration 045.
alter table public.telegram_requests add column selected_at timestamptz;

create or replace function public.claim_telegram_delivery(p_user uuid,p_token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare q public.telegram_requests; c public.telegram_connections; begin
 select * into c from public.telegram_connections where user_id=p_user for update;
 if not found then return null; end if;
 update public.telegram_requests set status='expired' where user_id=p_user and status='pending' and expires_at<=now();
 select * into q from public.telegram_requests where user_id=p_user and status='pending' order by selected_at desc nulls last,created_at,id limit 1 for update;
 if not found or q.delivered_version=q.version or q.next_attempt_at>now() or q.lease_until>now() or q.attempts>=5 then return null; end if;
 update public.telegram_requests set lease_token=p_token,lease_until=now()+interval '2 minutes',attempts=attempts+1 where id=q.id;
 return to_jsonb(q)||jsonb_build_object('thread_id',c.thread_id,'last_inbound_at',c.last_inbound_at);
end $$;
create or replace function public.transition_telegram_request(p_thread text,p_id uuid,p_version integer,p_state jsonb,p_message text,p_finish boolean default false,p_pause boolean default false)
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
 if q.id is distinct from (select id from public.telegram_requests where user_id=u and status='pending' and expires_at>now() order by selected_at desc nulls last,created_at,id limit 1) then return null; end if;
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

create function public.continue_telegram_application(p_thread text,p_application uuid,p_revision integer,p_action text,p_message text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid; r public.application_runs; q public.telegram_requests; prior_sub text; retried boolean; begin
 if p_action is null or p_action not in ('review','retry') or p_message is null or p_revision is null or p_revision<1 then return null; end if;
 select user_id into u from public.telegram_connections where thread_id=p_thread;
 if u is null then return null; end if;
 perform 1 from public.account_profiles where user_id=u for update;
 perform 1 from public.telegram_connections where user_id=u and thread_id=p_thread for update;
 if not found then return null; end if;
 select * into r from public.application_runs where id=p_application and user_id=u for update;
 if not found or r.revision<>p_revision or not r.automatic or r.status not in ('ready','needs_attention') then return null; end if;
 -- No Telegram retry/review can bypass an uncertain or previously attempted send.
 if r.receipt is not null or exists(select 1 from public.application_events where application_id=r.id and status in ('submitting','submitted','submission_unknown')) then return null; end if;
 if p_action='retry' and (r.status<>'needs_attention' or r.prepare_attempts>=3) then return null; end if;
 if p_action='review' and r.packet is null then return null; end if;
 insert into public.telegram_inbound(message_id) values(p_message) on conflict do nothing;
 if not found then return null; end if;
 if p_action='retry' then
  prior_sub:=current_setting('request.jwt.claim.sub',true);
  perform set_config('request.jwt.claim.sub',u::text,true);
  retried:=public.retry_application_preparation(r.id);
  perform set_config('request.jwt.claim.sub',coalesce(prior_sub,''),true);
  if not retried then return null; end if;
  update public.application_runs set auto_submit_requested_at=null where id=r.id;
  return jsonb_build_object('userId',u,'applicationId',r.id,'action','retry');
 end if;
 select * into q from public.telegram_requests where application_id=r.id and revision=r.revision for update;
 if found and q.status='completed' then return null; end if;
 -- Clear old delivery leases; a concurrent sender must recheck before disclosure.
 update public.telegram_requests set lease_token=null,lease_until=null where user_id=u and status='pending';
 insert into public.telegram_requests(user_id,application_id,revision,packet,state,selected_at)
 values(u,r.id,r.revision,r.packet,jsonb_build_object('answers',r.packet->'answers','confirmed','[]'::jsonb,'initialized',false,'editing',false),clock_timestamp())
 on conflict(application_id,revision) do update set
  state=case when telegram_requests.packet=excluded.packet then jsonb_set(telegram_requests.state,'{editing}','false') else excluded.state end,
  packet=excluded.packet,status='pending',version=telegram_requests.version+1,selected_at=excluded.selected_at,
  expires_at=now()+interval '24 hours',attempts=0,next_attempt_at=now(),delivered_version=0,
  provider_message_id=null,lease_token=null,lease_until=null,last_error=null;
 return jsonb_build_object('userId',u,'applicationId',r.id,'action','review');
end $$;
revoke all on function public.continue_telegram_application(text,uuid,integer,text,text) from public,anon,authenticated;
grant execute on function public.continue_telegram_application(text,uuid,integer,text,text) to service_role;
