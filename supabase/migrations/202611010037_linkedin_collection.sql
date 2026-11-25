-- Public LinkedIn search windows are observations, never employer inventories.
-- No source is enabled and no jobs are inserted by this migration.
alter table public.job_source_directory add column config jsonb not null default '{}';
alter table public.job_source_directory drop constraint job_source_directory_kind_check;
alter table public.job_source_directory add constraint job_source_directory_kind_check check(kind in ('ashby','greenhouse','lever','arbeitnow','smartrecruiters','workday','linkedin'));
alter table public.job_source_directory drop constraint job_source_directory_check;
alter table public.job_source_directory add constraint job_source_directory_check check(
 (kind in ('arbeitnow','linkedin') and board is null and id=kind) or
 (kind not in ('arbeitnow','linkedin') and board is not null and id=kind||':'||board and (
   (kind<>'workday' and board ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$') or
   (kind='workday' and board ~ '^[a-z0-9][a-z0-9-]{0,62}\.wd[0-9]{1,2}\.myworkdayjobs\.com~[A-Za-z0-9][A-Za-z0-9_-]{0,99}$'))));

create function public.valid_linkedin_config(p_config jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare q jsonb;
begin
 if jsonb_typeof(p_config) is distinct from 'object' or jsonb_typeof(p_config->'queries') is distinct from 'array' then return false; end if;
 if jsonb_array_length(p_config->'queries') not between 1 and 8 then return false; end if;
 for q in select * from jsonb_array_elements(p_config->'queries') loop
   if jsonb_typeof(q) is distinct from 'object' or
     jsonb_typeof(q->'keywords') is distinct from 'string' or length(trim(q->>'keywords')) not between 2 and 100 or
     jsonb_typeof(q->'location') is distinct from 'string' or length(trim(q->>'location')) not between 2 and 160 or
     jsonb_typeof(q->'country') is distinct from 'string' or length(trim(q->>'country')) not between 2 and 100 or
     (select count(*) from jsonb_object_keys(q))<>3 then return false; end if;
 end loop;
 return (select count(*) from jsonb_object_keys(p_config))=1;
end $$;
alter table public.job_source_directory add constraint linkedin_config_check check(kind<>'linkedin' or public.valid_linkedin_config(config));
revoke all on function public.valid_linkedin_config(jsonb) from public,anon,authenticated;
grant execute on function public.valid_linkedin_config(jsonb) to service_role;

create function public.configure_linkedin_source(p_query jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare queries jsonb; source public.job_source_directory;
begin
 if not public.valid_linkedin_config(jsonb_build_object('queries',jsonb_build_array(p_query))) then raise exception 'Invalid LinkedIn query'; end if;
 perform pg_catalog.pg_advisory_xact_lock(730111037);
 if exists(select 1 from public.job_catalog_sources s join public.job_catalog_runs r on r.id=s.current_run
   where s.id='linkedin' and (s.lease_until>now() or r.status in ('running','paused'))) then raise exception 'Finish the pending LinkedIn collection before changing its queries'; end if;
 select config->'queries' into queries from public.job_source_directory where id='linkedin' for update;
 queries:=coalesce(queries,'[]');
 if not queries @> jsonb_build_array(p_query) then queries:=queries||jsonb_build_array(p_query); end if;
 if jsonb_array_length(queries)>8 then raise exception 'Use at most eight LinkedIn queries'; end if;
 insert into public.job_source_directory(id,kind,company,board,enabled,countries,config)
   values('linkedin','linkedin','LinkedIn public jobs',null,true,array[p_query->>'country'],jsonb_build_object('queries',queries))
   on conflict(id) do update set config=excluded.config,enabled=true,
     countries=array(select distinct unnest(job_source_directory.countries||excluded.countries)) returning * into source;
 return to_jsonb(source);
end $$;
revoke all on function public.configure_linkedin_source(jsonb) from public,anon,authenticated;
grant execute on function public.configure_linkedin_source(jsonb) to service_role;

-- Preserve capacity wrappers, retention and ATS closure semantics.
create or replace function public.finish_catalog_run_without_capacity(p_run uuid,p_token uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare s public.job_catalog_sources; r public.job_catalog_runs; added integer; changed integer; expired integer; published integer; changed_ids text[];
begin
  select * into s from public.job_catalog_sources where current_run=p_run for update;
  if s.id is null or s.lease_token is distinct from p_token or s.lease_until<=now() then raise exception 'Collection lease lost'; end if;
  select * into r from public.job_catalog_runs where id=p_run;
  if r.next_page is not null then raise exception 'Collection is incomplete'; end if;
  -- Pending pages may predate retention or cross the age boundary.
  delete from public.job_catalog_run_items i where i.run_id=p_run
    and (i.data->>'posted_at')::timestamptz<now()-interval '30 days'
    and not exists(select 1 from public.job_catalog j where j.id=i.id);
  if exists(select 1 from public.job_catalog_run_items i where i.run_id=p_run
    and not coalesce(public.valid_catalog_description_ref(i.data->'description_ref'),false))
    then raise exception 'Unverified description reference'; end if;
  select count(*) into added from public.job_catalog_run_items i left join public.job_catalog j on j.id=i.id where i.run_id=p_run and j.id is null;
  select array_agg(i.id) into changed_ids from public.job_catalog_run_items i
    cross join lateral (
      select to_jsonb(j)-array['discovered_at','last_checked_at','is_active','sponsor_verified','posted_at','description','description_ref'] as fields,
        j.posted_at,public.catalog_description_fingerprint(j.description,j.description_ref) fingerprint
      from public.job_catalog j where j.id=i.id offset 0
    ) existing
    where i.run_id=p_run and (existing.fields is distinct from
        (i.data-array['sponsor_verified','posted_at','description','description_ref'])
      or existing.posted_at is distinct from (i.data->>'posted_at')::timestamptz
      or existing.fingerprint is distinct from public.catalog_description_fingerprint(i.data->>'description',i.data->'description_ref'));
  changed:=coalesce(cardinality(changed_ids),0);
  insert into public.job_catalog(id,title,company,country,city,url,description,description_ref,work_mode,visa_signal,sponsorship_evidence,sponsor_verified,source,posted_at,is_active,last_checked_at)
    select x.id,x.title,x.company,x.country,x.city,x.url,x.description,x.description_ref,x.work_mode,x.visa_signal::public.visa_confidence,x.sponsorship_evidence,false,s.id,x.posted_at,true,i.observed_at
    from public.job_catalog_run_items i cross join lateral jsonb_to_record(i.data)
    as x(id text,title text,company text,country text,city text,url text,description text,description_ref jsonb,work_mode text,visa_signal text,sponsorship_evidence text,posted_at timestamptz)
    where i.run_id=p_run
    on conflict(id) do update set title=excluded.title,company=excluded.company,country=excluded.country,
      city=excluded.city,url=excluded.url,description=excluded.description,description_ref=excluded.description_ref,work_mode=excluded.work_mode,
      visa_signal=excluded.visa_signal,sponsorship_evidence=excluded.sponsorship_evidence,
      posted_at=excluded.posted_at,is_active=true,last_checked_at=excluded.last_checked_at
    where job_catalog.id=any(changed_ids);
  update public.job_catalog j set last_checked_at=i.observed_at,is_active=true
    from public.job_catalog_run_items i where i.run_id=p_run and j.id=i.id and j.source=s.id
    and (j.last_checked_at is distinct from i.observed_at or j.is_active is distinct from true);
  select count(*) into published from public.job_catalog_run_items where run_id=p_run;
  expired:=0;
  if s.id<>'linkedin' then
    update public.job_catalog set is_active=false where source=s.id and is_active and
      not exists(select 1 from public.job_catalog_run_items i where i.run_id=p_run and i.id=job_catalog.id);
    get diagnostics expired=row_count;
  end if;
  update public.job_catalog_runs set status='succeeded',finished_at=now(),new_count=added,
    updated_count=changed,expired_count=expired where id=p_run returning * into r;
  update public.job_catalog_sources set last_success_at=now(),last_error=null,published_count=published,
    last_complete=(s.id<>'linkedin'),lease_until=null,lease_token=null where id=s.id;
  delete from public.job_catalog_run_items where run_id=p_run;
  return to_jsonb(r);
end $$;

-- A scoped refresh must not scan/download the full source directory, health,
-- country demand and availability on every small background batch.
create or replace function public.catalog_collection_sources(p_ids text[]) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
begin
 if p_ids is null or cardinality(p_ids)>100 then raise exception 'Use at most 100 source IDs'; end if;
 return (
  select coalesce(jsonb_agg(to_jsonb(selected) order by selected.id),'[]'::jsonb) from (
   select d.id,d.kind,d.company,d.board,d.config,d.countries,d.enabled,
    s.last_success_at,s.last_started_at,s.last_error is not null as failed,
    s.last_complete as complete,coalesce(r.status in ('running','paused'),false) as pending,
    s.lease_until,case when r.status<>'succeeded' then r.retry_at end as retry_at
   from public.job_source_directory d left join public.job_catalog_sources s on s.id=d.id
   left join public.job_catalog_runs r on r.id=s.current_run
   where d.enabled and d.id=any(p_ids)
  ) selected
 );
end $$;
revoke all on function public.catalog_collection_sources(text[]) from public,anon,authenticated;
grant execute on function public.catalog_collection_sources(text[]) to service_role;
create or replace function public.job_search_source_pool(p_id uuid,p_patterns text[]) returns jsonb
language sql stable security invoker set search_path='' as $$
 with scope as (select * from public.job_search_runs where id=p_id),
 matched as (
   select j.source,(array_agg(distinct j.title order by j.title))[1:12] titles,array_agg(distinct j.country) countries
   from public.job_catalog j,scope r where j.is_active and j.country=any(r.countries)
     and j.title ilike any(p_patterns[1:90]) group by j.source
 ), pool as (
   select d.id,d.kind,d.company,d.board,d.config,coalesce(m.titles,'{}') titles,
     coalesce(m.countries,d.countries) countries,s.last_success_at,
     greatest(coalesce(s.published_count,(c.validation->>'accepted_count')::integer,1),1) estimated_records,
     coalesce(q.next_page,1) cursor,m.source is not null has_roles,q.checked_at,q.new_records,
     row_number() over(partition by m.source is not null order by q.checked_at nulls first,
       md5(r.id::text||d.id)) slot
   from scope r cross join public.job_source_directory d
   left join matched m on m.source=d.id
   left join public.source_candidates c on c.id=d.id and c.status='activated'
   left join public.job_catalog_sources s on s.id=d.id
   left join public.job_catalog_runs current on current.id=s.current_run
   left join public.job_search_source_checks q on q.scope_key=r.scope_key and q.source=d.id
   left join public.job_search_provider_backoff b on b.kind=d.kind
   where d.enabled and d.kind in ('ashby','greenhouse','lever','smartrecruiters','workday','linkedin') and d.countries&&r.countries
     and (m.source is not null or c.id is not null or d.kind='linkedin')
     and (q.checked_at is null or q.checked_at<now()-interval '1 hour')
     and (q.retry_at is null or q.retry_at<=now()) and (b.retry_at is null or b.retry_at<=now())
     and (s.lease_until is null or s.lease_until<=now())
     and (current.retry_at is null or current.retry_at<=now() or current.status='succeeded')
 ) select coalesce(jsonb_agg(to_jsonb(selected)),'[]') from
   (select * from pool where slot<=400 order by has_roles desc,checked_at nulls first,slot) selected;
$$;

-- Public LinkedIn pages can contain 25 cards plus one detail request per card.
create or replace function public.publish_job_search_source(p_id uuid,p_token uuid,p_source text,p_jobs jsonb,p_complete boolean,p_next_page integer,p_requests integer)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare run public.job_search_runs; budget bigint; added integer; changed integer; changed_ids text[]; observed timestamptz:=now(); result jsonb;
begin
  select * into run from public.job_search_runs where id=p_id for update;
  if run.dispatch_token is distinct from p_token or run.status not in ('queued','running')
    or run.created_at<now()-interval '10 minutes' then raise exception 'Search lease lost'; end if;
  if not(run.sources @> jsonb_build_array(p_source)) then raise exception 'Source is outside the search plan'; end if;
  if run.results ? p_source then return run.results->p_source; end if;
  if jsonb_typeof(p_jobs)<>'array' or jsonb_array_length(p_jobs)>100 or octet_length(p_jobs::text)>1048576
    or p_requests not between 1 and 100 or (p_next_page is not null and p_next_page<1) then raise exception 'Invalid search observations'; end if;
  if exists(select 1 from jsonb_array_elements(p_jobs) x where x->>'source' is distinct from p_source
    or not coalesce(x->>'country'=any(run.countries),false) or coalesce(x->>'id','')=''
    or not coalesce(public.valid_catalog_description_ref(x->'description_ref'),false)) then raise exception 'Invalid search observation scope'; end if;
  if not exists(select 1 from public.job_source_directory where id=p_source and enabled) then raise exception 'Source is not enabled'; end if;
  if exists(select 1 from jsonb_array_elements(p_jobs) x join public.job_catalog j on j.id=x->>'id' where j.source<>p_source)
    then raise exception 'Existing listing source differs'; end if;
  insert into public.job_catalog_sources(id) values(p_source) on conflict do nothing;
  perform 1 from public.job_catalog_sources where id=p_source for update;
  if exists(select 1 from public.job_catalog_sources where id=p_source and lease_until>now()) then
    return public.record_job_search_source(p_id,p_token,p_source,'{"status":"deferred","records":0,"newRecords":0,"complete":false}'::jsonb);
  end if;
  p_jobs:=public.catalog_retention_jobs(p_jobs);
  -- This is bounded metadata; object bodies were verified before this call.
  perform pg_catalog.pg_advisory_xact_lock(730103006);
  select budget_bytes into strict budget from public.catalog_capacity_control where singleton;
  if pg_database_size(current_database())+octet_length(p_jobs::text)::bigint*3>budget then raise exception 'Catalogue storage budget reached'; end if;
  select count(*) into added from jsonb_array_elements(p_jobs) x left join public.job_catalog j on j.id=x->>'id' where j.id is null;
  select array_agg(x->>'id') into changed_ids from jsonb_array_elements(p_jobs) x
    join public.job_catalog j on j.id=x->>'id'
    where (to_jsonb(j)-array['discovered_at','last_checked_at','is_active','sponsor_verified','posted_at','description','description_ref'])
      is distinct from (x-array['sponsor_verified','posted_at','description','description_ref'])
      or j.posted_at is distinct from (x->>'posted_at')::timestamptz
      or public.catalog_description_fingerprint(j.description,j.description_ref) is distinct from
        public.catalog_description_fingerprint(x->>'description',x->'description_ref');
  changed:=coalesce(cardinality(changed_ids),0);
  insert into public.job_catalog(id,title,company,country,city,url,description,description_ref,work_mode,visa_signal,sponsorship_evidence,sponsor_verified,source,posted_at,is_active,last_checked_at)
    select x.id,x.title,x.company,x.country,x.city,x.url,x.description,x.description_ref,x.work_mode,x.visa_signal::public.visa_confidence,x.sponsorship_evidence,false,p_source,x.posted_at,true,observed
    from jsonb_to_recordset(p_jobs) as x(id text,title text,company text,country text,city text,url text,description text,description_ref jsonb,work_mode text,visa_signal text,sponsorship_evidence text,posted_at timestamptz)
    on conflict(id) do update set title=excluded.title,company=excluded.company,country=excluded.country,city=excluded.city,url=excluded.url,
      description=excluded.description,description_ref=excluded.description_ref,work_mode=excluded.work_mode,visa_signal=excluded.visa_signal,
      sponsorship_evidence=excluded.sponsorship_evidence,posted_at=excluded.posted_at,is_active=true,last_checked_at=excluded.last_checked_at
    where job_catalog.id=any(changed_ids) and (job_catalog.last_checked_at is null or job_catalog.last_checked_at<=observed);
  update public.job_catalog set last_checked_at=observed,is_active=true where id in(select x->>'id' from jsonb_array_elements(p_jobs) x)
    and source=p_source and (last_checked_at is null or last_checked_at<=observed);
  -- No missing-job expiry, source completion flag, or full-collection cursor changes.
  result:=jsonb_build_object('status','published','records',jsonb_array_length(p_jobs),'newRecords',added,'updatedRecords',changed,
    'complete',p_complete,'nextPage',p_next_page,'requests',p_requests);
  return public.record_job_search_source(p_id,p_token,p_source,result);
end $$;
