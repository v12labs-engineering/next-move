-- Service-only country rotation, paid-request reservations and crash evidence.
create table public.automatic_discovery_settings (
 singleton boolean primary key default true check(singleton),
 daily_search_limit integer not null default 48 check(daily_search_limit between 0 and 48),
 daily_budget_milliusd integer not null default 1000 check(daily_budget_milliusd between 0 and 1000)
);
insert into public.automatic_discovery_settings default values;
create table public.automatic_discovery_countries (
 country text primary key check(length(country) between 1 and 100),
 attempts integer not null default 0,
 last_attempt_at timestamptz, last_searched_at timestamptz,
 next_attempt_at timestamptz not null default now()
);
create table public.automatic_discovery_days (
 day date primary key, searches integer not null default 0 check(searches>=0),
 reserved_milliusd integer not null default 0 check(reserved_milliusd>=0)
);
create table public.automatic_discovery_runs (
 id uuid primary key default gen_random_uuid(), request_key text not null unique check(length(request_key) between 1 and 150),
 day date not null default (now() at time zone 'UTC')::date,
 token uuid not null default gen_random_uuid(),
 status text not null default 'running' check(status in ('running','completed','partial','failed','interrupted')),
 started_at timestamptz not null default now(), finished_at timestamptz,
 plan jsonb not null default '[]', activated_sources text[] not null default '{}', result jsonb
);
create table public.automatic_discovery_control (
 singleton boolean primary key default true check(singleton),
 current_run uuid references public.automatic_discovery_runs(id) on delete set null,
 lease_until timestamptz, last_started_at timestamptz, provider_retry_at timestamptz
);
insert into public.automatic_discovery_control default values;
create table public.automatic_discovery_queries (
 run_id uuid not null references public.automatic_discovery_runs(id) on delete cascade,
 ordinal integer not null check(ordinal between 0 and 11), country text not null references public.automatic_discovery_countries(country),
 query text not null check(length(query) between 1 and 200),
 status text not null default 'reserved' check(status in ('reserved','completed','failed')),
 reserved_at timestamptz not null default now(), completed_at timestamptz,
 http_status integer, result jsonb, candidate_ids text[] not null default '{}',
 primary key(run_id,ordinal)
);
create index automatic_discovery_candidate_history on public.automatic_discovery_queries(reserved_at) where status='completed';
do $$ declare name text; begin
 foreach name in array array['automatic_discovery_settings','automatic_discovery_countries','automatic_discovery_days','automatic_discovery_runs','automatic_discovery_control','automatic_discovery_queries'] loop
  execute format('alter table public.%I enable row level security',name);
  execute format('revoke all on public.%I from public,anon,authenticated',name);
  execute format('grant all on public.%I to service_role',name);
 end loop;
end $$;

create function public.initialize_automatic_discovery(p_countries text[]) returns void
language plpgsql security invoker set search_path='' as $$ begin
 if cardinality(p_countries) not between 1 and 300 or exists(select 1 from unnest(p_countries) c where c is null or length(c) not between 1 and 100) then raise exception 'Invalid discovery countries'; end if;
 insert into public.automatic_discovery_countries(country) select distinct unnest(p_countries) on conflict do nothing;
end $$;

-- Only aggregates leave the database. Stale/missing matching is unmeasured,
-- rather than a fabricated zero. Fresh supply uses live catalogue availability.
create function public.automatic_discovery_country_priority() returns jsonb
language sql stable security invoker set search_path='' as $$
 with per_account as (
  select c.country,c.user_id,
   coalesce(s.profile_version=p.version and s.computed_at>=now()-interval '1 day' and not s.failed,false) measured,
   count(distinct j.url) filter(where j.is_active and j.last_checked_at>=now()-interval '7 days'
    and j.posted_at between now()-interval '7 days' and now()
    and m.job->'match'->>'softwareRole'='true' and m.job->'match'->>'reviewable'='true'
    and coalesce(a.status,'new') not in ('applied','dismissed')) matches
  from public.account_countries c join public.account_profiles p on p.user_id=c.user_id
  left join public.account_match_state s on s.user_id=c.user_id
  left join public.account_match_jobs m on m.user_id=c.user_id and m.generation=s.generation and m.country=c.country
  left join public.job_catalog j on j.id=m.job_id
  left join public.account_job_states a on a.user_id=c.user_id and a.job_id=m.job_id
  group by c.country,c.user_id,s.profile_version,p.version,s.computed_at,s.failed
 ), demand as (
  select country,count(*) users,count(*) filter(where measured and matches<5) underserved,
   count(*) filter(where not measured) unmeasured from per_account group by country
 ) select coalesce(jsonb_agg(jsonb_build_object('country',c.country,'attempts',c.attempts,
  'last_attempt_at',c.last_attempt_at,'next_attempt_at',c.next_attempt_at,'users',coalesce(d.users,0),
  'underserved',coalesce(d.underserved,0),'unmeasured',coalesce(d.unmeasured,0)) order by c.country),'[]')
 from public.automatic_discovery_countries c left join demand d using(country);
$$;

create function public.claim_automatic_discovery(p_request_key text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare c public.automatic_discovery_control; r public.automatic_discovery_runs; budget bigint;
begin
 select * into c from public.automatic_discovery_control where singleton for update;
 select * into r from public.automatic_discovery_runs where request_key=p_request_key;
 if found then return jsonb_build_object('claimed',false,'id',r.id,'status',r.status,'result',r.result); end if;
 if c.lease_until>now() then return jsonb_build_object('claimed',false,'reason','leased'); end if;
 if c.last_started_at>now()-interval '4 hours' then return jsonb_build_object('claimed',false,'reason','cooldown'); end if;
 select budget_bytes into budget from public.catalog_capacity_control where singleton;
 if pg_database_size(current_database())+16777216>=budget then return jsonb_build_object('claimed',false,'reason','storage_budget'); end if;
 update public.automatic_discovery_runs set status='interrupted',finished_at=now() where id=c.current_run and status='running';
 insert into public.automatic_discovery_runs(request_key) values(p_request_key) returning * into r;
 update public.automatic_discovery_control set current_run=r.id,lease_until=now()+interval '10 minutes',last_started_at=now() where singleton;
 -- Small bounded retention; permanent source provenance remains in its own ledger.
 delete from public.automatic_discovery_runs where id in(select id from public.automatic_discovery_runs where finished_at<now()-interval '14 days' and id<>r.id order by finished_at limit 100);
 delete from public.automatic_discovery_days where day<(now() at time zone 'UTC')::date-90;
 return jsonb_build_object('claimed',true,'id',r.id,'token',r.token);
end $$;

create function public.set_automatic_discovery_plan(p_run uuid,p_token uuid,p_plan jsonb) returns void
language plpgsql security invoker set search_path='' as $$
declare c public.automatic_discovery_control; r public.automatic_discovery_runs;
begin
 select * into c from public.automatic_discovery_control where singleton for update;
 select * into r from public.automatic_discovery_runs where id=p_run for update;
 if c.current_run is distinct from p_run or c.lease_until is null or c.lease_until<=now() or r.token is distinct from p_token or r.status<>'running' then raise exception 'Discovery lease lost'; end if;
 if jsonb_typeof(p_plan) is distinct from 'array' or jsonb_array_length(p_plan)>6 or octet_length(p_plan::text)>16000 then raise exception 'Invalid discovery plan'; end if;
 if exists(select 1 from jsonb_array_elements(p_plan) x where not exists(select 1 from public.automatic_discovery_countries where country=x->>'country') or jsonb_typeof(x->'queries') is distinct from 'array' or jsonb_array_length(x->'queries')<>2) then raise exception 'Invalid discovery country'; end if;
 if exists(select 1 from jsonb_array_elements(p_plan) x cross join lateral jsonb_array_elements_text(x->'queries') q where length(q) not between 1 and 200) then raise exception 'Invalid discovery query'; end if;
 if (select count(distinct x->>'country') from jsonb_array_elements(p_plan)x)<>jsonb_array_length(p_plan) then raise exception 'Duplicate discovery country'; end if;
 if r.plan<>'[]' and r.plan<>p_plan then raise exception 'Discovery plan is immutable'; end if;
 update public.automatic_discovery_runs set plan=p_plan where id=p_run;
end $$;

create function public.reserve_automatic_discovery_search(p_run uuid,p_token uuid,p_ordinal integer,p_query text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare c public.automatic_discovery_control; r public.automatic_discovery_runs; q public.automatic_discovery_days;
 s public.automatic_discovery_settings; v_country text; today date:=(now() at time zone 'UTC')::date;
begin
 select * into c from public.automatic_discovery_control where singleton for update;
 select * into r from public.automatic_discovery_runs where id=p_run for update;
 if c.current_run is distinct from p_run or c.lease_until is null or c.lease_until<=now() or r.token is distinct from p_token or r.status<>'running' then raise exception 'Discovery lease lost'; end if;
 if p_ordinal not between 0 and 11 or r.plan->(p_ordinal/2)->'queries'->>(p_ordinal%2) is distinct from p_query then raise exception 'Query is outside discovery plan'; end if;
 if r.day<>today then return jsonb_build_object('allowed',false,'reason','day_boundary'); end if;
 if c.provider_retry_at>now() then return jsonb_build_object('allowed',false,'reason','provider_backoff'); end if;
 if exists(select 1 from public.automatic_discovery_queries where run_id=p_run and ordinal=p_ordinal) then return jsonb_build_object('allowed',false,'reason','already_reserved'); end if;
 insert into public.automatic_discovery_days(day) values(today) on conflict do nothing;
 select * into q from public.automatic_discovery_days where day=today for update;
 select * into s from public.automatic_discovery_settings where singleton for share;
 if q.searches>=s.daily_search_limit or q.reserved_milliusd+7>s.daily_budget_milliusd then return jsonb_build_object('allowed',false,'reason','daily_budget'); end if;
 v_country:=r.plan->(p_ordinal/2)->>'country';
 if not exists(select 1 from public.automatic_discovery_queries where run_id=p_run and automatic_discovery_queries.country=v_country) then
  update public.automatic_discovery_countries set attempts=attempts+1,last_attempt_at=now(),next_attempt_at=now()+interval '6 hours' where automatic_discovery_countries.country=v_country;
 end if;
 insert into public.automatic_discovery_queries(run_id,ordinal,country,query) values(p_run,p_ordinal,v_country,p_query);
 update public.automatic_discovery_days set searches=searches+1,reserved_milliusd=reserved_milliusd+7 where day=today;
 update public.automatic_discovery_control set lease_until=now()+interval '10 minutes' where singleton;
 return jsonb_build_object('allowed',true);
end $$;

-- Observation persistence and candidate intake are one transaction. No jobs are published here.
create function public.record_automatic_discovery_search(p_run uuid,p_token uuid,p_ordinal integer,p_status integer,p_result jsonb,p_origin jsonb,p_candidates jsonb,p_retry_at timestamptz default null) returns void
language plpgsql security invoker set search_path='' as $$
declare c public.automatic_discovery_control; r public.automatic_discovery_runs; q public.automatic_discovery_queries; ids text[];
begin
 select * into c from public.automatic_discovery_control where singleton for update;
 select * into r from public.automatic_discovery_runs where id=p_run;
 if c.current_run is distinct from p_run or c.lease_until is null or c.lease_until<=now() or r.token is distinct from p_token or r.status<>'running' then raise exception 'Discovery lease lost'; end if;
 select * into q from public.automatic_discovery_queries where run_id=p_run and ordinal=p_ordinal for update;
 if q.status is distinct from 'reserved' then raise exception 'Discovery query already settled or not reserved'; end if;
 if octet_length(p_result::text)>20000 or jsonb_typeof(p_candidates) is distinct from 'array' or jsonb_array_length(p_candidates)>1 then raise exception 'Discovery result exceeded limit'; end if;
 if p_status=200 then
  perform public.import_source_candidates(p_origin,p_candidates);
  select coalesce(array_agg(x->>'id'),'{}') into ids from jsonb_array_elements(p_candidates)x;
 end if;
 update public.automatic_discovery_queries set status=case when p_status=200 then 'completed' else 'failed' end,
  completed_at=now(),http_status=p_status,result=p_result,candidate_ids=coalesce(ids,'{}') where run_id=p_run and ordinal=p_ordinal;
 if p_status<>200 then
  update public.automatic_discovery_control set provider_retry_at=greatest(now()+interval '1 minute',coalesce(p_retry_at,now()+interval '15 minutes')) where singleton;
 end if;
 if (select count(*) from public.automatic_discovery_queries where run_id=p_run and country=q.country and status='completed')=2 then
  update public.automatic_discovery_countries set last_searched_at=now(),next_attempt_at=now()+interval '7 days' where country=q.country;
 end if;
 update public.automatic_discovery_control set lease_until=now()+interval '10 minutes' where singleton;
end $$;

create function public.automatic_discovery_pending_candidates() returns jsonb
language sql stable security invoker set search_path='' as $$
 select coalesce(jsonb_agg(to_jsonb(c)),'[]') from (
  select s.* from public.source_candidates s where s.id in (
   select unnest(candidate_ids) from public.automatic_discovery_queries where status='completed' and reserved_at>now()-interval '14 days'
  ) and (s.lease_until is null or s.lease_until<=now())
  and ((s.status='verified' and s.validated_at>now()-interval '24 hours' and coalesce((s.validation->>'fresh_count')::integer,0)>0)
   or (s.status not in ('activated','invalid') and s.next_attempt_at<=now()))
  order by s.created_at,s.id limit 12
 ) c;
$$;

create function public.activate_automatic_discovery_source(p_run uuid,p_token uuid,p_source text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare c public.automatic_discovery_control; r public.automatic_discovery_runs; v_result jsonb;
begin
 select * into c from public.automatic_discovery_control where singleton for update;
 select * into r from public.automatic_discovery_runs where id=p_run for update;
 if c.current_run is distinct from p_run or c.lease_until is null or c.lease_until<=now() or r.token is distinct from p_token or r.status<>'running' then raise exception 'Discovery lease lost'; end if;
 if not exists(select 1 from public.source_candidates s where s.id=p_source and s.status='verified' and coalesce((s.validation->>'fresh_count')::integer,0)>0 and s.validated_at>now()-interval '24 hours'
  and exists(select 1 from public.automatic_discovery_queries q where p_source=any(q.candidate_ids) and q.status='completed' and q.reserved_at>now()-interval '14 days')) then raise exception 'Fresh automatic source evidence required'; end if;
 v_result:=public.activate_source_candidate(p_source,'Automatic worldwide discovery: current provider identity, dated software postings and country evidence verified; complete collection required before publication.');
 update public.automatic_discovery_runs set activated_sources=array(select distinct unnest(activated_sources||array[p_source])) where id=p_run;
 update public.automatic_discovery_control set lease_until=now()+interval '10 minutes' where singleton;
 return v_result;
end $$;

create function public.finish_automatic_discovery(p_run uuid,p_token uuid,p_status text,p_result jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare c public.automatic_discovery_control; r public.automatic_discovery_runs; v_result jsonb;
begin
 select * into c from public.automatic_discovery_control where singleton for update;
 select * into r from public.automatic_discovery_runs where id=p_run for update;
 if c.current_run is distinct from p_run or c.lease_until is null or c.lease_until<=now() or r.token is distinct from p_token or r.status<>'running' then raise exception 'Discovery lease lost'; end if;
 if p_status is null or p_status not in ('completed','partial','failed') or jsonb_typeof(p_result) is distinct from 'object' or octet_length(p_result::text)>32000 then raise exception 'Invalid discovery settlement'; end if;
 select p_result||jsonb_build_object('id',p_run,'status',p_status,'activatedSources',r.activated_sources,
  'reservedSearches',count(*),'completedSearches',count(*) filter(where status='completed'),'reservedMilliusd',count(*)*7) into v_result from public.automatic_discovery_queries where run_id=p_run;
 update public.automatic_discovery_runs set status=p_status,result=v_result,finished_at=now() where id=p_run;
 update public.automatic_discovery_control set lease_until=null where singleton;
 return v_result;
end $$;

do $$ declare f record; begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in ('initialize_automatic_discovery','automatic_discovery_country_priority','claim_automatic_discovery','set_automatic_discovery_plan','reserve_automatic_discovery_search','record_automatic_discovery_search','automatic_discovery_pending_candidates','activate_automatic_discovery_source','finish_automatic_discovery') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
