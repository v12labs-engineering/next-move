-- Shared public job supply. Account profiles/statuses remain isolated.
alter table public.job_catalog add column is_active boolean not null default true;
alter table public.job_catalog add column last_checked_at timestamptz;
create index job_catalog_active_country_idx on public.job_catalog(country,discovered_at desc) where is_active;
create table public.job_catalog_sources (
  id text primary key,
  last_started_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  published_count integer not null default 0,
  lease_until timestamptz
);
alter table public.job_catalog_sources enable row level security;
revoke all on public.job_catalog_sources from public,anon,authenticated;
grant select on public.job_catalog_sources to authenticated;
grant all on public.job_catalog_sources to service_role;
create policy catalog_sources_read on public.job_catalog_sources for select to authenticated using(true);

create function public.claim_catalog_source(p_source text) returns boolean language plpgsql security invoker set search_path='' as $$
declare claimed text;
begin
  insert into public.job_catalog_sources(id,last_started_at,lease_until) values(p_source,now(),now()+interval '5 minutes')
  on conflict(id) do update set last_started_at=now(),lease_until=now()+interval '5 minutes'
    where public.job_catalog_sources.lease_until is null or public.job_catalog_sources.lease_until<now()
  returning id into claimed;
  return claimed is not null;
end $$;

create function public.publish_catalog_source(p_source text,p_jobs jsonb,p_complete boolean) returns integer language plpgsql security invoker set search_path='' as $$
declare published integer;
begin
  if jsonb_typeof(p_jobs) is distinct from 'array' or jsonb_array_length(p_jobs)>5000 then raise exception 'Invalid source snapshot'; end if;
  if exists(select 1 from jsonb_array_elements(p_jobs) j where j->>'source' is distinct from p_source) then raise exception 'Source mismatch'; end if;
  insert into public.job_catalog(id,title,company,country,city,url,description,work_mode,visa_signal,sponsorship_evidence,sponsor_verified,source,posted_at,is_active,last_checked_at)
  select id,title,company,country,city,url,description,work_mode,visa_signal::public.visa_confidence,sponsorship_evidence,false,source,posted_at,true,now()
  from jsonb_to_recordset(p_jobs) as x(id text,title text,company text,country text,city text,url text,description text,work_mode text,visa_signal text,sponsorship_evidence text,source text,posted_at timestamptz)
  on conflict(id) do update set title=excluded.title,company=excluded.company,country=excluded.country,city=excluded.city,url=excluded.url,description=excluded.description,work_mode=excluded.work_mode,visa_signal=excluded.visa_signal,sponsorship_evidence=excluded.sponsorship_evidence,posted_at=excluded.posted_at,is_active=true,last_checked_at=now();
  get diagnostics published=row_count;
  update public.job_catalog set is_active=false where source=p_source and is_active and
    ((p_complete and id not in(select j->>'id' from jsonb_array_elements(p_jobs) j))
      or (not p_complete and last_checked_at<now()-interval '7 days'));
  update public.job_catalog_sources set last_success_at=now(),last_error=null,published_count=published,lease_until=null where id=p_source;
  return published;
end $$;
revoke all on function public.claim_catalog_source(text),public.publish_catalog_source(text,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.claim_catalog_source(text),public.publish_catalog_source(text,jsonb,boolean) to service_role;
