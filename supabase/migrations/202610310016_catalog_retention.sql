-- Known source posting dates expire after 30 rolling days. Account history is
-- protected globally; no age is inferred from discovery/check timestamps.
create index job_catalog_retention_idx on public.job_catalog(posted_at,id) where posted_at is not null;
create index account_job_states_job_idx on public.account_job_states(job_id);
create index resume_drafts_job_idx on public.resume_drafts(job_id);
create index application_runs_job_idx on public.application_runs(job_id);
create index application_runs_target_idx on public.application_runs(target_url);
create index account_match_jobs_job_idx on public.account_match_jobs(job_id);

create function public.catalog_retention_jobs(p_jobs jsonb) returns jsonb
language sql stable security invoker set search_path='' as $$
 select coalesce(jsonb_agg(item order by ordinal),'[]') from jsonb_array_elements(p_jobs) with ordinality as observations(item,ordinal)
 where (item->>'posted_at')::timestamptz is null or (item->>'posted_at')::timestamptz>=now()-interval '30 days'
   or exists(select 1 from public.job_catalog j where j.id=item->>'id');
$$;

-- Backstop for old workers and direct operator imports. Existing retained rows
-- may still receive observations, including an explicit source closure.
create function public.catalog_retention_insert_guard() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if new.posted_at<now()-interval '30 days' and not exists(select 1 from public.job_catalog where id=new.id) then return null; end if;
 return new;
end $$;
create trigger a_catalog_retention_insert before insert on public.job_catalog
for each row execute function public.catalog_retention_insert_guard();

create function public.cleanup_catalog_jobs(p_limit integer default 500) returns jsonb
language plpgsql security invoker set search_path='' set lock_timeout='2s' as $$
declare removed integer;
begin
 if p_limit is null or p_limit not between 1 and 1000 then raise exception 'Invalid cleanup limit'; end if;
 if not pg_catalog.pg_try_advisory_xact_lock(730103116) then return jsonb_build_object('deleted',0,'more',true,'busy',true); end if;
 -- Block status/reference edits briefly while selecting and deleting a batch.
 -- This closes the race with a concurrent dismiss-to-saved status update.
 lock table public.account_job_states,public.resume_drafts,public.application_runs in share mode;
 with candidates as materialized (
   select j.id from public.job_catalog j where j.posted_at<now()-interval '30 days'
     and not exists(select 1 from public.account_job_states a where a.job_id=j.id and a.status in ('interested','applied'))
     and not exists(select 1 from public.resume_drafts d where d.job_id=j.id)
     and not exists(select 1 from public.application_runs a where a.job_id=j.id or a.target_url=j.url)
   order by j.posted_at,j.id limit p_limit for update of j skip locked
 ), deleted as (delete from public.job_catalog j using candidates c where j.id=c.id returning j.id)
 select count(*) into removed from deleted;
 return jsonb_build_object('deleted',removed,'more',removed=p_limit,'busy',false);
end $$;

-- Claim whole unreferenced packs before external deletion. Writers cannot attach
-- a claimed reference; failed storage deletion keeps the claim for retry.
alter table public.catalog_content_packs add column deleting_at timestamptz, add column cleanup_token uuid;
create index job_catalog_content_pack_idx on public.job_catalog((description_ref->>'pack')) where description_ref is not null;
create index catalog_run_content_pack_idx on public.job_catalog_run_items((data->'description_ref'->>'pack'));
create or replace function public.valid_catalog_description_ref(p_ref jsonb) returns boolean
language sql stable security invoker set search_path='' as $$
 select p_ref is null or p_ref='null'::jsonb or (
   jsonb_typeof(p_ref)='object' and p_ref->>'v'='1'
   and p_ref->>'pack' ~ '^[a-f0-9]{64}$' and p_ref->>'sha256' ~ '^[a-f0-9]{64}$'
   and (p_ref->>'offset')::integer>=0 and (p_ref->>'length')::integer>0
   and (p_ref->>'bytes')::integer between 1 and 240000
   and exists(select 1 from public.catalog_content_packs p where p.id=p_ref->>'pack' and p.ready and p.deleting_at is null
     and (p_ref->>'offset')::integer+(p_ref->>'length')::integer<=p.bytes)
 );
$$;
create function public.catalog_staged_content_guard() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if not coalesce(public.valid_catalog_description_ref(new.data->'description_ref'),false) then raise exception 'Unverified staged description reference'; end if;
 return new;
end $$;
create trigger catalog_staged_content_guard before insert or update of data on public.job_catalog_run_items
for each row execute function public.catalog_staged_content_guard();

create function public.claim_catalog_content_cleanup(p_limit integer default 32) returns jsonb
language plpgsql security invoker set search_path='' set lock_timeout='2s' as $$
declare result jsonb; token uuid:=gen_random_uuid();
begin
 if p_limit is null or p_limit not between 1 and 100 then raise exception 'Invalid cleanup limit'; end if;
 perform pg_catalog.pg_advisory_xact_lock(730103105);
 -- Wait for in-flight catalogue/staging writes before checking references.
 lock table public.job_catalog,public.job_catalog_run_items in share row exclusive mode;
 with unused as materialized (
   select p.id from public.catalog_content_packs p where ((p.deleting_at is null and p.created_at<now()-interval '24 hours') or p.deleting_at<now()-interval '15 minutes')
     and not exists(select 1 from public.job_catalog j where j.description_ref->>'pack'=p.id)
     and not exists(select 1 from public.job_catalog_run_items i where i.data->'description_ref'->>'pack'=p.id)
   order by p.created_at,p.id limit p_limit for update of p skip locked
 ), claimed as (
   update public.catalog_content_packs p set deleting_at=now(),cleanup_token=token from unused u where p.id=u.id returning p.id,p.bytes,p.cleanup_token as token
 ) select coalesce(jsonb_agg(to_jsonb(claimed)),'[]') into result from claimed;
 return result;
end $$;
create function public.finish_catalog_content_cleanup(p_ids text[],p_token uuid) returns integer
language plpgsql security invoker set search_path='' as $$
declare removed integer;
begin
 if p_ids is null or cardinality(p_ids)>100 then raise exception 'Invalid cleanup IDs'; end if;
 perform pg_catalog.pg_advisory_xact_lock(730103105);
 delete from public.catalog_content_packs p where p.id=any(p_ids) and p.deleting_at is not null and p.cleanup_token=p_token
   and not exists(select 1 from public.job_catalog j where j.description_ref->>'pack'=p.id)
   and not exists(select 1 from public.job_catalog_run_items i where i.data->'description_ref'->>'pack'=p.id);
 get diagnostics removed=row_count;
 return removed;
end $$;

create or replace function public.reserve_catalog_content(p_id text,p_bytes integer) returns void
language plpgsql security invoker set search_path='' as $$
declare used bigint; existing integer;
begin
  if p_id !~ '^[a-f0-9]{64}$' or p_bytes not between 1 and 524288 then raise exception 'Invalid content pack'; end if;
  perform pg_catalog.pg_advisory_xact_lock(730103105);
  select bytes into existing from public.catalog_content_packs where id=p_id;
  if existing is not null then
    if exists(select 1 from public.catalog_content_packs where id=p_id and deleting_at is not null) then raise exception 'Content pack is being removed; retry later'; end if;
    if existing<>p_bytes then raise exception 'Content pack mismatch'; end if;
    return;
  end if;
  select coalesce(sum(bytes),0) into used from public.catalog_content_packs;
  -- Keep a separate bounded allowance below the existing free 1 GB object quota.
  if used+p_bytes>805306368 then raise exception 'Catalogue object storage budget reached'; end if;
  insert into public.catalog_content_packs(id,bytes) values(p_id,p_bytes);
end $$;

create or replace function public.checkpoint_catalog_page_without_capacity(p_run uuid,p_token uuid,p_page integer,p_next integer,
  p_jobs jsonb,p_fetched integer,p_rejected integer,p_requests integer) returns void
language plpgsql security invoker set search_path='' as $$
declare s public.job_catalog_sources; r public.job_catalog_runs; inserted integer;
begin
  select * into s from public.job_catalog_sources where current_run=p_run for update;
  if s.id is null or s.lease_token is distinct from p_token or s.lease_until<=now() then raise exception 'Collection lease lost'; end if;
  select * into r from public.job_catalog_runs where id=p_run;
  if p_page is distinct from r.next_page or p_page<1 or (p_next is not null and p_next<=p_page) then raise exception 'Invalid continuation'; end if;
  if jsonb_typeof(p_jobs) is distinct from 'array' or jsonb_array_length(p_jobs)>100000 or
    p_fetched<0 or p_rejected<0 or p_rejected>p_fetched or p_requests<1 then raise exception 'Invalid page'; end if;
  if exists(select 1 from jsonb_array_elements(p_jobs) j where j->>'source' is distinct from s.id or coalesce(j->>'id','')='') then raise exception 'Source mismatch'; end if;
  p_jobs:=public.catalog_retention_jobs(p_jobs);
  insert into public.job_catalog_run_items(run_id,id,data)
    select p_run,j->>'id',j from jsonb_array_elements(p_jobs) j on conflict do nothing;
  get diagnostics inserted=row_count;
  update public.job_catalog_run_items i set data=page.data,observed_at=now()
    from (select distinct on (j->>'id') j->>'id' id,j data from jsonb_array_elements(p_jobs) j) page
    where i.run_id=p_run and i.id=page.id;
  update public.job_source_directory set countries=array(select distinct country from
    (select unnest(countries) country union select j->>'country' from jsonb_array_elements(p_jobs) j) scopes
    where country is not null) where id=s.id;
  update public.job_catalog_runs set next_page=p_next,pages=pages+1,
    fetched_count=fetched_count+p_fetched,rejected_count=rejected_count+p_rejected,
    accepted_count=accepted_count+jsonb_array_length(p_jobs),
    duplicate_count=duplicate_count+jsonb_array_length(p_jobs)-inserted,
    request_count=request_count+p_requests where id=p_run;
  update public.job_catalog_sources set lease_until=now()+interval '5 minutes' where id=s.id;
end $$;

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
  update public.job_catalog set is_active=false where source=s.id and is_active and
    not exists(select 1 from public.job_catalog_run_items i where i.run_id=p_run and i.id=job_catalog.id);
  get diagnostics expired=row_count;
  update public.job_catalog_runs set status='succeeded',finished_at=now(),new_count=added,
    updated_count=changed,expired_count=expired where id=p_run returning * into r;
  update public.job_catalog_sources set last_success_at=now(),last_error=null,published_count=published,
    last_complete=true,lease_until=null,lease_token=null where id=s.id;
  delete from public.job_catalog_run_items where run_id=p_run;
  return to_jsonb(r);
end $$;

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


revoke all on function public.catalog_retention_jobs(jsonb),public.catalog_retention_insert_guard(),public.cleanup_catalog_jobs(integer),public.catalog_staged_content_guard(),public.claim_catalog_content_cleanup(integer),public.finish_catalog_content_cleanup(text[],uuid) from public,anon,authenticated;
grant execute on function public.catalog_retention_jobs(jsonb),public.catalog_retention_insert_guard(),public.cleanup_catalog_jobs(integer),public.catalog_staged_content_guard(),public.claim_catalog_content_cleanup(integer),public.finish_catalog_content_cleanup(text[],uuid) to service_role;
