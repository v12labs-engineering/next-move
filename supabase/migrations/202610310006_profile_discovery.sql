-- Profile-scoped discovery upserts observed matches. It never infers closures
-- from a filtered board response and never labels it a complete source snapshot.
create table public.job_search_source_checks (
  scope_key text not null, source text not null references public.job_source_directory(id),
  checked_at timestamptz not null default now(), next_page integer,
  new_records integer not null default 0, retry_at timestamptz,
  primary key(scope_key,source)
);
create table public.job_search_provider_backoff (
  kind text primary key, retry_at timestamptz not null
);
alter table public.job_search_source_checks enable row level security;
alter table public.job_search_provider_backoff enable row level security;
revoke all on public.job_search_source_checks,public.job_search_provider_backoff from public,anon,authenticated;
grant all on public.job_search_source_checks,public.job_search_provider_backoff to service_role;

create or replace function public.job_search_source_pool(p_id uuid,p_patterns text[]) returns jsonb
language sql stable security invoker set search_path='' as $$
 with scope as (select * from public.job_search_runs where id=p_id),
 matched as (
   select j.source,(array_agg(distinct j.title order by j.title))[1:12] titles,array_agg(distinct j.country) countries
   from public.job_catalog j,scope r where j.is_active and j.country=any(r.countries)
     and j.title ilike any(p_patterns[1:90]) group by j.source
 ), pool as (
   select d.id,d.kind,d.company,d.board,coalesce(m.titles,'{}') titles,
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
   where d.enabled and d.kind in ('ashby','greenhouse','lever') and d.countries&&r.countries
     and (m.source is not null or c.id is not null)
     and (q.checked_at is null or q.checked_at<now()-interval '1 hour')
     and (q.retry_at is null or q.retry_at<=now()) and (b.retry_at is null or b.retry_at<=now())
     and (s.lease_until is null or s.lease_until<=now())
     and (current.retry_at is null or current.retry_at<=now() or current.status='succeeded')
 ) select coalesce(jsonb_agg(to_jsonb(selected)),'[]') from
   (select * from pool where slot<=400 order by has_roles desc,checked_at nulls first,slot) selected;
$$;

create function public.record_job_search_source(p_id uuid,p_token uuid,p_source text,p_result jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare run public.job_search_runs; provider_kind text;
begin
  select * into run from public.job_search_runs where id=p_id for update;
  if run.dispatch_token is distinct from p_token or run.status not in ('queued','running')
    or run.created_at<now()-interval '10 minutes' then raise exception 'Search lease lost'; end if;
  if not(run.sources @> jsonb_build_array(p_source)) then raise exception 'Source is outside the search plan'; end if;
  if run.results ? p_source then return run.results->p_source; end if;
  if coalesce(p_result->>'status','') not in ('published','deferred','failed','limited')
    or coalesce((p_result->>'records')::integer,0) not between 0 and 100
    or coalesce((p_result->>'newRecords')::integer,0) not between 0 and coalesce((p_result->>'records')::integer,0) then raise exception 'Invalid source result'; end if;
  update public.job_search_runs set results=results||jsonb_build_object(p_source,p_result),version=version+1,updated_at=now() where id=p_id;
  insert into public.job_search_source_checks(scope_key,source,checked_at,next_page,new_records,retry_at)
    values(run.scope_key,p_source,now(),(p_result->>'nextPage')::integer,
      coalesce((p_result->>'newRecords')::integer,0),(p_result->>'retryAt')::timestamptz)
    on conflict(scope_key,source) do update set checked_at=excluded.checked_at,next_page=excluded.next_page,
      new_records=excluded.new_records,retry_at=excluded.retry_at;
  if p_result->>'providerBackoffUntil' is not null then
    select d.kind into provider_kind from public.job_source_directory d where d.id=p_source;
    insert into public.job_search_provider_backoff values(provider_kind,(p_result->>'providerBackoffUntil')::timestamptz)
      on conflict(kind) do update set retry_at=greatest(job_search_provider_backoff.retry_at,excluded.retry_at);
  end if;
  return p_result;
end $$;

create function public.publish_job_search_source(p_id uuid,p_token uuid,p_source text,p_jobs jsonb,p_complete boolean,p_next_page integer,p_requests integer)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare run public.job_search_runs; budget bigint; added integer; changed integer; changed_ids text[]; observed timestamptz:=now(); result jsonb;
begin
  select * into run from public.job_search_runs where id=p_id for update;
  if run.dispatch_token is distinct from p_token or run.status not in ('queued','running')
    or run.created_at<now()-interval '10 minutes' then raise exception 'Search lease lost'; end if;
  if not(run.sources @> jsonb_build_array(p_source)) then raise exception 'Source is outside the search plan'; end if;
  if run.results ? p_source then return run.results->p_source; end if;
  if jsonb_typeof(p_jobs)<>'array' or jsonb_array_length(p_jobs)>100 or octet_length(p_jobs::text)>1048576
    or p_requests not between 1 and 9 or (p_next_page is not null and p_next_page<1) then raise exception 'Invalid search observations'; end if;
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

create or replace function public.job_search_status_json(p_run uuid) returns jsonb
language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('id',r.id,'status',r.status,'reason',r.reason,
   'roles',r.roles,'countries',r.countries,'createdAt',r.created_at,'updatedAt',r.updated_at,
   'retryAt',r.created_at+interval '1 hour','version',r.version,
   'plannedSources',coalesce(jsonb_array_length(r.sources),0),
   'processedSources',(select count(*) from jsonb_each(r.results)),
   'publishedSources',(select count(*) from jsonb_each(r.results) x where x.value->>'status'='published'),
   'publishedRecords',(select coalesce(sum((x.value->>'records')::integer),0) from jsonb_each(r.results) x),
   'newRecords',(select case when count(*) filter(where x.value->>'status'='published' and not(x.value ? 'newRecords'))>0 then null
     else coalesce(sum((x.value->>'newRecords')::integer),0) end from jsonb_each(r.results) x))
 from public.job_search_runs r where r.id=p_run;
$$;

revoke all on function public.record_job_search_source(uuid,uuid,text,jsonb),public.publish_job_search_source(uuid,uuid,text,jsonb,boolean,integer,integer) from public,anon,authenticated;
grant execute on function public.record_job_search_source(uuid,uuid,text,jsonb),public.publish_job_search_source(uuid,uuid,text,jsonb,boolean,integer,integer) to service_role;
