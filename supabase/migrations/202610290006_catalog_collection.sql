-- Durable, operator-only ingestion. Existing listing and account history stays intact.
create table public.job_source_directory (
  id text primary key,
  kind text not null check(kind in ('ashby','greenhouse','lever','arbeitnow')),
  company text not null,
  board text,
  enabled boolean not null default false,
  discovered_url text,
  countries text[] not null default '{}',
  created_at timestamptz not null default now(),
  check ((kind='arbeitnow' and board is null and id='arbeitnow') or
    (kind<>'arbeitnow' and board is not null and board ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$' and id=kind||':'||board))
);
insert into public.job_source_directory(id,kind,company,board,enabled) values
 ('ashby:n8n','ashby','n8n','n8n',true), ('ashby:deepl','ashby','DeepL','deepl',true),
 ('ashby:mistral.ai','ashby','Mistral AI','mistral.ai',true),
 ('ashby:elevenlabs','ashby','ElevenLabs','elevenlabs',true),
 ('ashby:linear','ashby','Linear','linear',true), ('arbeitnow','arbeitnow','Arbeitnow',null,true),
 ('greenhouse:newrelic','greenhouse','New Relic','newrelic',true),
 ('greenhouse:deliveroo','greenhouse','Deliveroo','deliveroo',true);
update public.job_source_directory d set countries=inventory.countries from
  (select source,array_agg(distinct country) countries from public.job_catalog group by source) inventory
  where d.id=inventory.source;

create table public.job_catalog_runs (
  id uuid primary key default gen_random_uuid(),
  source text not null references public.job_source_directory(id),
  status text not null default 'running' check(status in ('running','paused','succeeded')),
  started_at timestamptz not null default now(), finished_at timestamptz,
  next_page integer default 1,
  attempts integer not null default 0,
  pages integer not null default 0,
  fetched_count integer not null default 0, rejected_count integer not null default 0,
  accepted_count integer not null default 0, duplicate_count integer not null default 0,
  request_count integer not null default 0,
  new_count integer not null default 0, updated_count integer not null default 0,
  expired_count integer not null default 0,
  last_error text, last_failed_at timestamptz
);
create index catalog_runs_source_time on public.job_catalog_runs(source,started_at desc);
create table public.job_catalog_run_items (
  run_id uuid not null references public.job_catalog_runs(id) on delete cascade,
  id text not null, data jsonb not null, observed_at timestamptz not null default now(), primary key(run_id,id)
);
alter table public.job_catalog_sources add column current_run uuid references public.job_catalog_runs(id);
alter table public.job_catalog_sources add column lease_token uuid;
alter table public.job_catalog_sources add column last_complete boolean;

alter table public.job_source_directory enable row level security;
alter table public.job_catalog_runs enable row level security;
alter table public.job_catalog_run_items enable row level security;
revoke all on public.job_source_directory,public.job_catalog_runs,public.job_catalog_run_items from public,anon,authenticated;
grant all on public.job_source_directory,public.job_catalog_runs,public.job_catalog_run_items to service_role;

create function public.begin_catalog_run(p_source text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare s public.job_catalog_sources; r public.job_catalog_runs; token uuid:=gen_random_uuid();
begin
  if not exists(select 1 from public.job_source_directory where id=p_source and enabled) then
    raise exception 'Source is not enabled';
  end if;
  insert into public.job_catalog_sources(id) values(p_source) on conflict do nothing;
  select * into s from public.job_catalog_sources where id=p_source for update;
  if s.lease_until>now() then return null; end if;
  select * into r from public.job_catalog_runs where id=s.current_run and status<>'succeeded';
  if r.id is null then
    insert into public.job_catalog_runs(source) values(p_source) returning * into r;
  end if;
  update public.job_catalog_runs set attempts=attempts+1,status='running' where id=r.id returning * into r;
  update public.job_catalog_sources set current_run=r.id,lease_token=token,
    lease_until=now()+interval '5 minutes',last_started_at=now() where id=p_source;
  return to_jsonb(r)||jsonb_build_object('token',token);
end $$;

create function public.checkpoint_catalog_page(p_run uuid,p_token uuid,p_page integer,p_next integer,
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

create function public.pause_catalog_run(p_run uuid,p_token uuid,p_error text default null,p_requests integer default 0) returns void
language plpgsql security invoker set search_path='' as $$
declare source_id text;
begin
  select id into source_id from public.job_catalog_sources where current_run=p_run and lease_token=p_token for update;
  if source_id is null then raise exception 'Collection lease lost'; end if;
  if p_requests<0 then raise exception 'Invalid request count'; end if;
  update public.job_catalog_runs set status='paused',request_count=request_count+p_requests,last_error=coalesce(left(p_error,300),last_error),
    last_failed_at=case when p_error is null then last_failed_at else now() end where id=p_run;
  update public.job_catalog_sources set lease_until=null,lease_token=null,
    last_error=p_error where id=source_id;
end $$;

create function public.finish_catalog_run(p_run uuid,p_token uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare s public.job_catalog_sources; r public.job_catalog_runs; added integer; changed integer; expired integer; published integer;
begin
  select * into s from public.job_catalog_sources where current_run=p_run for update;
  if s.id is null or s.lease_token is distinct from p_token or s.lease_until<=now() then raise exception 'Collection lease lost'; end if;
  select * into r from public.job_catalog_runs where id=p_run;
  if r.next_page is not null then raise exception 'Collection is incomplete'; end if;
  select count(*) into added from public.job_catalog_run_items i left join public.job_catalog j on j.id=i.id where i.run_id=p_run and j.id is null;
  select count(*) into changed from public.job_catalog_run_items i join public.job_catalog j on j.id=i.id where i.run_id=p_run and
    (to_jsonb(j)-array['discovered_at','last_checked_at','is_active','sponsor_verified']) is distinct from (i.data-'sponsor_verified');
  insert into public.job_catalog(id,title,company,country,city,url,description,work_mode,visa_signal,sponsorship_evidence,sponsor_verified,source,posted_at,is_active,last_checked_at)
    select x.id,x.title,x.company,x.country,x.city,x.url,x.description,x.work_mode,x.visa_signal::public.visa_confidence,x.sponsorship_evidence,false,s.id,x.posted_at,true,i.observed_at
    from public.job_catalog_run_items i cross join lateral jsonb_to_record(i.data)
    as x(id text,title text,company text,country text,city text,url text,description text,work_mode text,visa_signal text,sponsorship_evidence text,posted_at timestamptz)
    where i.run_id=p_run
    on conflict(id) do update set title=excluded.title,company=excluded.company,country=excluded.country,
      city=excluded.city,url=excluded.url,description=excluded.description,work_mode=excluded.work_mode,
      visa_signal=excluded.visa_signal,sponsorship_evidence=excluded.sponsorship_evidence,
      posted_at=excluded.posted_at,is_active=true,last_checked_at=excluded.last_checked_at;
  get diagnostics published=row_count;
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

-- Aggregate destination demand only; no identities or resume data leave storage.
create function public.catalog_source_demand(p_after text default null,p_limit integer default 500) returns table(source text,demand bigint)
language sql stable security definer set search_path='' as $$
  select inventory.source,count(*) from (select distinct source,country from public.job_catalog) inventory
  join public.account_countries c on c.country=inventory.country
  where p_after is null or inventory.source>p_after group by inventory.source
  order by inventory.source limit least(greatest(p_limit,1),500);
$$;
create function public.catalog_source_health(p_after text default null,p_limit integer default 500)
returns table(id text,countries text[],enabled boolean,last_success_at timestamptz,last_started_at timestamptz,failed boolean,complete boolean,pending boolean)
language sql stable security definer set search_path='' as $$
  select d.id,d.countries,d.enabled,s.last_success_at,s.last_started_at,s.last_error is not null,s.last_complete,
    coalesce(r.status in ('running','paused'),false)
  from public.job_source_directory d left join public.job_catalog_sources s on s.id=d.id
  left join public.job_catalog_runs r on r.id=s.current_run
  where p_after is null or d.id>p_after order by d.id limit least(greatest(p_limit,1),500);
$$;
revoke all on function public.begin_catalog_run(text),public.checkpoint_catalog_page(uuid,uuid,integer,integer,jsonb,integer,integer,integer),
  public.pause_catalog_run(uuid,uuid,text,integer),public.finish_catalog_run(uuid,uuid),public.catalog_source_demand(text,integer) from public,anon,authenticated;
grant execute on function public.begin_catalog_run(text),public.checkpoint_catalog_page(uuid,uuid,integer,integer,jsonb,integer,integer,integer),
  public.pause_catalog_run(uuid,uuid,text,integer),public.finish_catalog_run(uuid,uuid),public.catalog_source_demand(text,integer) to service_role;
revoke all on function public.catalog_source_health(text,integer) from public,anon;
grant execute on function public.catalog_source_health(text,integer) to authenticated,service_role;
