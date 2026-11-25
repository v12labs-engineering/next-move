-- Customer requests contain only canonical saved roles/countries. Shared work
-- and operator details are private; customers can read only their own status.
create table public.job_search_runs (
  id uuid primary key default gen_random_uuid(),
  scope_key text not null,
  roles text[] not null,
  countries text[] not null,
  status text not null default 'queued' check(status in ('queued','running','completed','partial','paused','failed')),
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  workflow_id text,
  dispatch_token uuid,
  dispatch_until timestamptz,
  sources jsonb,
  results jsonb not null default '{}',
  version integer not null default 0
);
create index job_search_scope_time on public.job_search_runs(scope_key,created_at desc);
create index job_search_created on public.job_search_runs(created_at);
create table public.account_job_searches (
  user_id uuid primary key references auth.users(id) on delete cascade,
  run_id uuid not null references public.job_search_runs(id),
  requested_at timestamptz not null default now()
);
create table public.job_search_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  run_id uuid not null references public.job_search_runs(id),
  created_at timestamptz not null default now()
);
create index job_search_account_time on public.job_search_requests(user_id,created_at desc);
create table public.job_search_steps (
  run_id uuid not null references public.job_search_runs(id) on delete cascade,
  step_key text not null,
  primary key(run_id,step_key)
);
create table public.job_search_control (
  singleton boolean primary key default true check(singleton),
  enabled boolean not null default true,
  daily_runs integer not null default 12 check(daily_runs between 1 and 12),
  account_daily_requests integer not null default 3 check(account_daily_requests between 1 and 3)
);
insert into public.job_search_control(singleton) values(true);
alter table public.job_search_runs enable row level security;
alter table public.account_job_searches enable row level security;
alter table public.job_search_requests enable row level security;
alter table public.job_search_steps enable row level security;
alter table public.job_search_control enable row level security;
revoke all on public.job_search_runs,public.account_job_searches,public.job_search_requests,public.job_search_steps,public.job_search_control from public,anon,authenticated;
grant all on public.job_search_runs,public.account_job_searches,public.job_search_requests,public.job_search_steps,public.job_search_control to service_role;

create function public.job_search_profile() returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare data jsonb; roles text[]; countries text[];
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  select p.data into data from public.account_profiles p where user_id=auth.uid();
  if data is null or jsonb_typeof(data->'targetRoles') is distinct from 'array' then raise exception 'Complete your profile first'; end if;
  select array_agg(role order by role) into roles from
    (select distinct lower(trim(value)) role from jsonb_array_elements_text(data->'targetRoles')) r;
  select array_agg(country order by country) into countries from public.account_countries where user_id=auth.uid();
  if coalesce(cardinality(roles),0) not between 1 and 30 or coalesce(cardinality(countries),0) not between 1 and 8
    or exists(select 1 from unnest(roles) r where length(r) not between 1 and 100) then raise exception 'Complete your profile first'; end if;
  return jsonb_build_object('roles',roles,'countries',countries,'key',md5(jsonb_build_array(roles,countries)::text));
end $$;

create function public.job_search_status_json(p_run uuid) returns jsonb
language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('id',r.id,'status',r.status,'reason',r.reason,
   'roles',r.roles,'countries',r.countries,'createdAt',r.created_at,'updatedAt',r.updated_at,
   'retryAt',r.created_at+interval '1 hour','version',r.version,
   'plannedSources',coalesce(jsonb_array_length(r.sources),0),
   'processedSources',(select count(*) from jsonb_each(r.results)),
   'publishedSources',(select count(*) from jsonb_each(r.results) x where x.value->>'status'='published'),
   'publishedRecords',(select coalesce(sum((x.value->>'records')::integer),0) from jsonb_each(r.results) x))
 from public.job_search_runs r where r.id=p_run;
$$;

create function public.request_job_search() returns jsonb
language plpgsql security definer set search_path='' as $$
declare profile jsonb; run public.job_search_runs; own public.account_job_searches;
  control public.job_search_control; day_start timestamptz:=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC';
begin
  profile:=public.job_search_profile();
  perform pg_catalog.pg_advisory_xact_lock(730103016);
  select * into strict control from public.job_search_control where singleton;
  if not control.enabled then return jsonb_build_object('search',null,'blocked','disabled'); end if;
  update public.job_search_runs set status='partial',reason='time_limit',updated_at=now(),version=version+1
    where status in ('queued','running') and created_at<now()-interval '10 minutes';
  -- Bound ledger history without deleting listings or account/job history.
  delete from public.job_search_requests where created_at<now()-interval '7 days';
  delete from public.job_search_runs r where r.created_at<now()-interval '7 days'
    and r.status not in ('queued','running')
    and not exists(select 1 from public.account_job_searches a where a.run_id=r.id)
    and not exists(select 1 from public.job_search_requests q where q.run_id=r.id);
  select * into own from public.account_job_searches where user_id=auth.uid();
  select * into run from public.job_search_runs where id=own.run_id;
  if run.scope_key=profile->>'key' and run.created_at>now()-interval '1 hour' then
    return jsonb_build_object('search',public.job_search_status_json(run.id),'reused',true);
  end if;
  if own.requested_at>now()-interval '1 hour' then
    return jsonb_build_object('search',null,'blocked','account_cooldown','retryAt',own.requested_at+interval '1 hour');
  end if;
  if (select count(*) from public.job_search_requests where user_id=auth.uid() and created_at>=day_start)>=control.account_daily_requests then
    return jsonb_build_object('search',null,'blocked','account_daily_limit','retryAt',day_start+interval '1 day');
  end if;
  select * into run from public.job_search_runs where scope_key=profile->>'key'
    and created_at>now()-interval '1 hour' order by created_at desc limit 1;
  if run.id is null then
    if exists(select 1 from public.job_search_runs where status in ('queued','running')) then
      return jsonb_build_object('search',null,'blocked','busy','retryAt',now()+interval '1 minute');
    end if;
    if (select count(*) from public.job_search_runs where created_at>=day_start)>=control.daily_runs then
      return jsonb_build_object('search',null,'blocked','shared_daily_limit','retryAt',day_start+interval '1 day');
    end if;
    insert into public.job_search_runs(scope_key,roles,countries)
      select profile->>'key',array(select jsonb_array_elements_text(profile->'roles')),array(select jsonb_array_elements_text(profile->'countries'))
      returning * into run;
  end if;
  insert into public.account_job_searches(user_id,run_id) values(auth.uid(),run.id)
    on conflict(user_id) do update set run_id=excluded.run_id,requested_at=now();
  insert into public.job_search_requests(user_id,run_id) values(auth.uid(),run.id);
  return jsonb_build_object('search',public.job_search_status_json(run.id),'reused',run.created_at<now());
end $$;

create function public.read_job_search() returns jsonb
language plpgsql security definer set search_path='' as $$
declare profile jsonb; run public.job_search_runs;
begin
  profile:=public.job_search_profile();
  select r.* into run from public.account_job_searches a join public.job_search_runs r on r.id=a.run_id
    where a.user_id=auth.uid() and r.scope_key=profile->>'key';
  if run.id is null then return null; end if;
  if run.status in ('queued','running') and run.created_at<now()-interval '10 minutes' then
    update public.job_search_runs set status='partial',reason='time_limit',updated_at=now(),version=version+1
      where id=run.id and status in ('queued','running');
  end if;
  return public.job_search_status_json(run.id);
end $$;

create function public.claim_job_search_dispatch(p_id uuid) returns uuid
language plpgsql security invoker set search_path='' as $$
declare token uuid:=gen_random_uuid(); claimed uuid;
begin
  update public.job_search_runs set dispatch_token=token,dispatch_until=now()+interval '2 minutes'
    where id=p_id and status='queued' and workflow_id is null
    and created_at>now()-interval '10 minutes' and (dispatch_until is null or dispatch_until<=now())
    returning id into claimed;
  return case when claimed is not null then token end;
end $$;

create function public.record_job_search_step(p_id uuid,p_token uuid,p_step text,p_results jsonb) returns void
language plpgsql security invoker set search_path='' as $$
declare run public.job_search_runs; inserted integer;
begin
 select * into run from public.job_search_runs where id=p_id for update;
 if run.dispatch_token is distinct from p_token or run.status not in ('queued','running')
   or run.created_at<now()-interval '10 minutes' then raise exception 'Search lease lost'; end if;
 if jsonb_typeof(p_results) is distinct from 'object' or
   (select count(*) from jsonb_each(p_results))>2 or exists(
     select 1 from jsonb_each(p_results) x where not (run.sources @> jsonb_build_array(x.key))
       or coalesce(x.value->>'status','') not in ('published','fresh','deferred','failed','limited')
       or coalesce((x.value->>'records')::integer,0) not between 0 and 100) then raise exception 'Invalid search progress'; end if;
 insert into public.job_search_steps(run_id,step_key) values(p_id,p_step) on conflict do nothing;
 get diagnostics inserted=row_count;
 if inserted=1 then update public.job_search_runs set results=results||p_results,version=version+1,updated_at=now() where id=p_id; end if;
end $$;

-- Source evidence is operator-only. Broad SQL patterns are a prefilter; the
-- shared TypeScript title gate makes the final profession decision.
create function public.job_search_source_pool(p_id uuid,p_patterns text[]) returns jsonb
language sql stable security invoker set search_path='' as $$
 with scope as (select * from public.job_search_runs where id=p_id),
 matched as (
   select j.source,(array_agg(distinct j.title order by j.title))[1:8] titles,array_agg(distinct j.country) countries
   from public.job_catalog j,scope r where j.is_active and j.country=any(r.countries)
     and j.title ilike any(p_patterns[1:90]) group by j.source
 ), pool as (
   select d.id,d.kind,d.company,d.board,
     coalesce(m.titles,'{}') titles,coalesce(m.countries,d.countries) countries,
     s.last_success_at,
     case when s.last_success_at is not null then s.published_count else (c.validation->>'accepted_count')::integer end estimated_records,
     m.source is not null has_roles,s.last_started_at,
     md5(r.id::text||d.id) rotation
   from scope r cross join public.job_source_directory d
   left join matched m on m.source=d.id
   left join public.source_candidates c on c.id=d.id and c.status='activated'
   left join public.job_catalog_sources s on s.id=d.id
   left join public.job_catalog_runs current on current.id=s.current_run
   where d.enabled and d.kind in ('ashby','greenhouse','lever') and d.countries&&r.countries
     and (s.last_success_at is null or s.last_success_at<now()-interval '1 hour')
     and (s.lease_until is null or s.lease_until<=now())
     and (current.retry_at is null or current.retry_at<=now() or current.status='succeeded')
     and (m.source is not null or (s.last_success_at is null and c.id is not null))
 ) select coalesce(jsonb_agg(to_jsonb(selected)),'[]'::jsonb) from
   (select * from pool where estimated_records between 1 and 100
    order by has_roles desc,estimated_records,last_started_at nulls first,rotation limit 120) selected;
$$;

create function public.catalog_run_size(p_run uuid,p_token uuid) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
begin
 if not exists(select 1 from public.job_catalog_sources where current_run=p_run and lease_token=p_token and lease_until>now()) then raise exception 'Collection lease lost'; end if;
 return (select jsonb_build_object('records',count(*),'bytes',coalesce(sum(octet_length(data::text)),0)) from public.job_catalog_run_items where run_id=p_run);
end $$;

revoke all on function public.job_search_profile(),public.job_search_status_json(uuid),public.request_job_search(),public.read_job_search(),public.claim_job_search_dispatch(uuid),public.record_job_search_step(uuid,uuid,text,jsonb),public.job_search_source_pool(uuid,text[]),public.catalog_run_size(uuid,uuid) from public,anon,authenticated;
grant execute on function public.request_job_search(),public.read_job_search() to authenticated;
grant execute on function public.job_search_profile(),public.job_search_status_json(uuid),public.claim_job_search_dispatch(uuid),public.record_job_search_step(uuid,uuid,text,jsonb),public.job_search_source_pool(uuid,text[]),public.catalog_run_size(uuid,uuid) to service_role;
