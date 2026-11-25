-- Additive: legacy review-first packets keep their original behavior.
alter table public.application_runs add column auto_submit_requested_at timestamptz,
 add column automatic boolean not null default false;

create function public.application_target(p_url text) returns text language sql immutable set search_path='' as $$
 select case
 when p_url ~ '^https://jobs[.]ashbyhq[.]com/[A-Za-z0-9_.-]+/[a-fA-F0-9-]{36}(/application)?/?([?#].*)?$'
 then regexp_replace(split_part(split_part(p_url,'?',1),'#',1),'(/application)?/?$','')||'/application'
 when p_url ~ '^https://(job-boards[.]greenhouse[.]io|boards[.]greenhouse[.]io|job-boards[.]eu[.]greenhouse[.]io)/[A-Za-z0-9_.-]+/jobs/[0-9]+/?([?#].*)?$'
 then regexp_replace(split_part(split_part(p_url,'?',1),'#',1),'/$','')
 when p_url ~ '^https://jobs([.]eu)?[.]lever[.]co/[A-Za-z0-9_.-]+/[a-fA-F0-9-]{36}(/apply)?/?([?#].*)?$'
 then regexp_replace(split_part(split_part(p_url,'?',1),'#',1),'(/apply)?/?$','')||'/apply'
 else null end
$$;
revoke all on function public.application_target(text) from public,anon;
grant execute on function public.application_target(text) to authenticated,service_role;

create or replace function public.create_application(p_job text) returns uuid language plpgsql security definer set search_path='' as $$
declare j public.job_catalog; v_id uuid; v_url text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  -- Serialize per account, bounding new browser work before a worker starts.
  perform 1 from public.account_profiles where user_id=auth.uid() for update;
  if not found then raise exception 'Complete your profile'; end if;
  select * into j from public.job_catalog where id=p_job and is_active and last_checked_at>now()-interval '7 days';
  if not found then raise exception 'Unsupported or expired listing'; end if;
  v_url:=public.application_target(j.url);
  if v_url is null then raise exception 'Unsupported or expired listing'; end if;
  select id into v_id from public.application_runs where user_id=auth.uid() and target_url=v_url;
  if v_id is not null then return v_id; end if;
  if (select count(*) from public.application_runs where user_id=auth.uid() and created_at>now()-interval '1 day')>=5 then raise exception 'Daily preparation limit reached'; end if;
  if not public.reserve_tailoring_attempt() then raise exception 'Daily AI limit reached'; end if;
  insert into public.application_runs(user_id,job_id,target_url) values(auth.uid(),j.id,v_url) returning id into v_id;
  return v_id;
end $$;

-- The UI explicitly describes tailoring and sending to this employer before this
-- owner-derived action. Repeated requests return the same run, never a new send.
create function public.request_automatic_application(p_job text) returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid; begin
 v_id:=public.create_application(p_job);
 update public.application_runs set auto_submit_requested_at=now(),automatic=true,updated_at=now()
 where id=v_id and user_id=auth.uid() and status in ('queued_prepare','ready');
 return v_id;
end $$;
revoke all on function public.request_automatic_application(text) from public,anon;
grant execute on function public.request_automatic_application(text) to authenticated;

-- Only the runner can freeze a newly prepared packet under the initial request.
create function public.queue_automatic_application(p_id uuid,p_revision integer) returns boolean language plpgsql security definer set search_path='' as $$
begin
 update public.application_runs set status='queued',approved_packet=packet,approved_revision=revision,approved_at=now(),updated_at=now()
 where id=p_id and revision=p_revision and status='ready' and packet is not null
 and auto_submit_requested_at>now()-interval '30 minutes';
 return found;
end $$;
revoke all on function public.queue_automatic_application(uuid,integer) from public,anon,authenticated;
grant execute on function public.queue_automatic_application(uuid,integer) to service_role;

-- In-app answers, edit invalidation and renewed approval commit atomically.
create function public.continue_application(p_id uuid,p_revision integer,p_answers jsonb,p_resume text) returns integer language plpgsql security definer set search_path='' as $$
declare v integer; begin
 v:=public.edit_application(p_id,p_revision,p_answers,p_resume);
 if not public.approve_application(p_id,v) then raise exception 'Application changed'; end if;
 return v;
end $$;
revoke all on function public.continue_application(uuid,integer,jsonb,text) from public,anon;
grant execute on function public.continue_application(uuid,integer,jsonb,text) to authenticated;

-- Changes and cancellation remove initial automatic authorization too.
create function public.invalidate_automatic_request() returns trigger language plpgsql set search_path='' as $$
begin
 if new.revision<>old.revision or new.status='cancelled' then new.auto_submit_requested_at:=null; end if;
 return new;
end $$;
revoke all on function public.invalidate_automatic_request() from public,anon,authenticated;
create trigger application_auto_invalidation before update on public.application_runs
for each row execute function public.invalidate_automatic_request();
