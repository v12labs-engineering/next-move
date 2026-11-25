-- Site-independent destinations. Network/DNS checks are repeated by the browser;
-- client/SQL URL syntax alone never authorizes an outbound request.
create function public.public_application_target(p_url text) returns text language plpgsql immutable set search_path='' as $$
declare v_host text; v_suffix text; v_authority text;
begin
 if length(p_url)>8000 or p_url ~ '[[:space:]]' or position(chr(92) in p_url)>0
 or p_url !~ '^https://([A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?[.])+[A-Za-z]{2,63}(:443)?([/?#].*)?$' then return null; end if;
 v_authority:=substring(p_url from '^https://([^/?#]+)');
 v_host:=lower(regexp_replace(v_authority,':443$',''));
 if v_host ~ '[.](localhost|local|internal|home|lan|test|invalid|example)$' then return null; end if;
 v_suffix:=substring(p_url from length(v_authority)+9);
 if v_suffix='' or left(v_suffix,1) in ('?','#') then v_suffix:='/'||v_suffix; end if;
 return 'https://'||v_host||v_suffix;
end $$;
revoke all on function public.public_application_target(text) from public,anon;
grant execute on function public.public_application_target(text) to authenticated,service_role;

-- Preserve prior canonical URLs for deduplication. They do not gate eligibility.
create or replace function public.application_target(p_url text) returns text language sql immutable set search_path='' as $$
 select case
 when u ~ '^https://jobs[.]ashbyhq[.]com/[A-Za-z0-9_.-]+/[a-fA-F0-9-]{36}(/application)?/?([?#].*)?$'
 then regexp_replace(split_part(split_part(u,'?',1),'#',1),'(/application)?/?$','')||'/application'
 when u ~ '^https://(job-boards[.]greenhouse[.]io|boards[.]greenhouse[.]io|job-boards[.]eu[.]greenhouse[.]io)/[A-Za-z0-9_.-]+/jobs/[0-9]+/?([?#].*)?$'
 then regexp_replace(split_part(split_part(u,'?',1),'#',1),'/$','')
 when u ~ '^https://jobs([.]eu)?[.]lever[.]co/[A-Za-z0-9_.-]+/[a-fA-F0-9-]{36}(/apply)?/?([?#].*)?$'
 then regexp_replace(split_part(split_part(u,'?',1),'#',1),'(/apply)?/?$','')||'/apply'
 else u end from (select public.public_application_target(p_url) u) validated
$$;

alter table public.application_runs add column employer_key text,
 add column decision_attempts integer not null default 0 check(decision_attempts between 0 and 6);
update public.application_runs a set employer_key=coalesce(nullif(lower(btrim(j.company)),''),split_part(a.target_url,'/',3))
from public.job_catalog j where a.job_id=j.id;
update public.application_runs set employer_key=split_part(target_url,'/',3) where employer_key is null;
create unique index application_runs_job_once on public.application_runs(user_id,job_id) where job_id is not null;

create or replace function public.create_application(p_job text) returns uuid language plpgsql security definer set search_path='' as $$
declare j public.job_catalog; v_id uuid; v_url text;
begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 perform 1 from public.account_profiles where user_id=auth.uid() for update;
 if not found then raise exception 'Complete your profile'; end if;
 select * into j from public.job_catalog where id=p_job and is_active and last_checked_at>now()-interval '7 days';
 if not found then raise exception 'Unsupported or expired listing'; end if;
 v_url:=public.application_target(j.url);
 if v_url is null then raise exception 'A public HTTPS listing is required'; end if;
 select id into v_id from public.application_runs where user_id=auth.uid() and (job_id=j.id or target_url=v_url) order by (job_id=j.id) desc limit 1;
 if v_id is not null then return v_id; end if;
 if (select count(*) from public.application_runs where user_id=auth.uid() and created_at>now()-interval '1 day')>=5 then raise exception 'Daily preparation limit reached'; end if;
 if not public.reserve_tailoring_attempt() then raise exception 'Daily AI limit reached'; end if;
 insert into public.application_runs(user_id,job_id,target_url,employer_key)
 values(auth.uid(),j.id,v_url,coalesce(nullif(lower(btrim(j.company)),''),split_part(v_url,'/',3))) returning id into v_id;
 return v_id;
end $$;

-- Extra browser-agent decisions share the existing account quota. A reservation
-- precedes every provider call; failed provider calls still count. Service-only.
create function public.reserve_application_decision(p_id uuid) returns boolean language plpgsql security definer set search_path='' as $$
declare r public.application_runs; v integer;
begin
 select * into r from public.application_runs where id=p_id for update;
 if not found or r.status not in ('preparing','running') or r.decision_attempts>=6 then return false; end if;
 insert into public.account_ai_usage(user_id,day,attempts) values(r.user_id,(now() at time zone 'UTC')::date,1)
 on conflict(user_id,day) do update set attempts=public.account_ai_usage.attempts+1
 where public.account_ai_usage.attempts<10 returning attempts into v;
 if v is null then return false; end if;
 update public.application_runs set decision_attempts=decision_attempts+1 where id=r.id;
 return true;
end $$;
revoke all on function public.reserve_application_decision(uuid) from public,anon,authenticated;
grant execute on function public.reserve_application_decision(uuid) to service_role;

-- Employer identity, not an ATS URL segment, determines concurrent-send limits.
-- Lock order matches creation/authorization: account first, application second.
create or replace function public.claim_application(p_id uuid,p_revision integer) returns setof public.application_runs language plpgsql security definer set search_path='' as $$
declare r public.application_runs; v_owner uuid; v_employer text;
begin
 select user_id into v_owner from public.application_runs where id=p_id;
 if not found then return; end if;
 perform 1 from public.account_profiles where user_id=v_owner for update;
 select * into r from public.application_runs where id=p_id for update;
 if not found or r.status<>'queued' or r.revision<>p_revision or r.approved_revision<>p_revision or r.packet<>r.approved_packet then return; end if;
 v_employer:=coalesce(r.employer_key,split_part(r.target_url,'/',3));
 if r.approved_at<now()-interval '30 minutes' or exists(
 select 1 from public.application_runs a where a.user_id=r.user_id and a.id<>r.id
 and coalesce(a.employer_key,split_part(a.target_url,'/',3))=v_employer
 and (a.status in ('running','submitting','submission_unknown') or
 (v_employer='n8n' and a.status='submitted' and a.updated_at>now()-interval '15 days'))
 ) then
 update public.application_runs set status='needs_attention',message='Another application to this employer is running, has an uncertain result, or is inside the employer cooldown. Review before continuing.',updated_at=now() where id=r.id;
 return;
 end if;
 return query update public.application_runs set status='running',started_at=now(),updated_at=now() where id=r.id returning *;
end $$;

-- A new packet version can resume discovery; the daily ledger still bounds
-- total provider attempts across all versions, retries and applications.
create function public.reset_application_decisions() returns trigger language plpgsql set search_path='' as $$
begin
 if new.revision<>old.revision then new.decision_attempts:=0; end if;
 return new;
end $$;
revoke all on function public.reset_application_decisions() from public,anon,authenticated;
create trigger application_decision_version before update on public.application_runs
for each row execute function public.reset_application_decisions();
