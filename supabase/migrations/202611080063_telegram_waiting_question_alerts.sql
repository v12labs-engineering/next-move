-- Waiting questions need their own alert even while another Telegram review
-- owns the conversation. Reuse the attention outbox; never change the review.
create function public.telegram_attention_required(p_status text,p_packet jsonb) returns boolean
language sql immutable set search_path='' as $$
 select p_status='needs_attention' or (p_status='ready' and exists(
  select 1 from jsonb_array_elements(p_packet->'fields') f
  where f->>'kind'<>'resume' and (f->>'required')::boolean
   and not public.application_answer_valid(f,p_packet->'answers'->(f->>'id'))
 ))
$$;
revoke all on function public.telegram_attention_required(text,jsonb) from public,anon,authenticated;

create or replace function public.sync_telegram_attention() returns trigger
language plpgsql security definer set search_path='' as $$ begin
 if not public.telegram_attention_required(new.status,new.packet) then
  delete from public.telegram_attention_notifications where application_id=new.id;
  return new;
 end if;
 if TG_OP='UPDATE' and old.status=new.status and old.revision=new.revision
  and old.message is not distinct from new.message
  and old.packet is not distinct from new.packet then return new; end if;
 insert into public.telegram_attention_notifications(application_id,user_id,revision)
 select new.id,new.user_id,new.revision
 where exists(select 1 from public.telegram_connections where user_id=new.user_id)
 on conflict(application_id) do update set revision=excluded.revision,
  version=telegram_attention_notifications.version+1,attempts=0,next_attempt_at=now(),
  lease_token=null,lease_until=null,delivered_at=null,last_error=null;
 return new;
end $$;
drop trigger application_telegram_attention on public.application_runs;
create trigger application_telegram_attention after insert or update of status,revision,message,packet on public.application_runs
 for each row execute function public.sync_telegram_attention();

create or replace function public.sync_telegram_attention_connection() returns trigger
language plpgsql security definer set search_path='' as $$ begin
 if TG_OP='DELETE' then
  delete from public.telegram_attention_notifications where user_id=old.user_id;
  return old;
 end if;
 insert into public.telegram_attention_notifications(application_id,user_id,revision)
 select id,user_id,revision from public.application_runs where user_id=new.user_id
  and public.telegram_attention_required(status,packet)
 on conflict(application_id) do update set revision=excluded.revision,
  version=telegram_attention_notifications.version+1,attempts=0,next_attempt_at=now(),
  lease_token=null,lease_until=null,delivered_at=null,last_error=null;
 return new;
end $$;

create or replace function public.claim_telegram_attention(p_application uuid,p_token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare n public.telegram_attention_notifications; destination text; title text; company text; begin
 if p_token is null then return null; end if;
 select a.* into n from public.telegram_attention_notifications a
 join public.application_runs r on r.id=a.application_id and r.user_id=a.user_id
  and public.telegram_attention_required(r.status,r.packet) and r.revision=a.revision
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

-- Backfill only newly covered waiting applications. Existing failure alerts,
-- selected conversations, answers and submission permissions remain intact.
insert into public.telegram_attention_notifications(application_id,user_id,revision)
 select r.id,r.user_id,r.revision from public.application_runs r
 join public.telegram_connections c on c.user_id=r.user_id
 where r.status='ready' and public.telegram_attention_required(r.status,r.packet)
 on conflict(application_id) do nothing;
