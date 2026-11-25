-- One owner-supplied response for one observed view. Code payloads are encrypted
-- by the webhook and exist only in the active private task output until cleared.
create index application_telegram_challenge on public.application_tasks ((output->'telegramChallenge'->>'id'))
 where state='running' and error_code='telegram_verification_required';
create function public.queue_telegram_verification(p_thread text,p_challenge uuid,p_action text,p_target integer,p_value text,p_reply text,p_update text)
returns boolean language plpgsql security definer set search_path='' as $$
declare u uuid; r public.application_runs; t public.application_tasks; c jsonb; begin
 if p_challenge is null or p_update is null or p_action is null or p_action not in ('code','click') then return false; end if;
 select user_id into u from public.telegram_connections where thread_id=p_thread;
 if u is null then return false; end if;
 perform 1 from public.account_profiles where user_id=u for update;
 perform 1 from public.telegram_connections where user_id=u and thread_id=p_thread for update;
 if not found then return false; end if;
 select a.* into r from public.application_runs a join public.application_tasks q on q.application_id=a.id
 where a.user_id=u and q.output->'telegramChallenge'->>'id'=p_challenge::text for update of a;
 if not found then return false; end if;
 select * into t from public.application_tasks where application_id=r.id and revision=r.revision
 and state='running' and error_code='telegram_verification_required' and output->'telegramChallenge'->>'id'=p_challenge::text for update;
 if not found or t.output->'browserAssistance'->>'expiresAt' is null or (t.output->'browserAssistance'->>'expiresAt')::timestamptz<=now()
 or not((t.stage='read_employer_form' and r.status='preparing') or (t.stage='fill_employer_form' and r.status='running') or (t.stage='submit' and r.status='submitting'))
 or (r.status<>'preparing' and r.approved_revision is distinct from r.revision) then return false; end if;
 c:=t.output->'telegramChallenge';
 if c->>'state' is distinct from 'waiting' then return false; end if;
 if p_action='code' and (c->>'mode' is distinct from 'code' or p_reply is null or c->>'replyMessageId' is distinct from p_reply or p_value is null or length(p_value)>128 or p_value !~ '^[A-Za-z0-9_-]{40,128}$') then return false; end if;
 if p_action='click' and (c->>'mode' is distinct from 'challenge' or p_target is null or p_target<0 or p_target>=coalesce((c->>'targetCount')::integer,0) or p_value is not null) then return false; end if;
 insert into public.telegram_inbound(message_id) values(p_update) on conflict do nothing;
 if not found then return false; end if;
 update public.application_tasks set output=jsonb_set(output,'{telegramChallenge}',c||jsonb_build_object('state','queued','command',jsonb_build_object('action',p_action,'target',p_target,'value',p_value)))
 where application_id=t.application_id and revision=t.revision and stage=t.stage;
 return true;
end $$;
revoke all on function public.queue_telegram_verification(text,uuid,text,integer,text,text,text) from public,anon,authenticated;
grant execute on function public.queue_telegram_verification(text,uuid,text,integer,text,text,text) to service_role;
