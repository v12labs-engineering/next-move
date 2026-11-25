create table if not exists tracked_countries (
  country text primary key,
  source_tier text not null check (source_tier in ('official_register', 'stale_register', 'discovery_proxy')),
  added_at timestamptz not null default now()
);

insert into tracked_countries (country, source_tier, added_at)
select
  jobs.country,
  case
    when jobs.country in ('Netherlands', 'Denmark', 'Ireland', 'Japan') then 'official_register'
    when jobs.country = 'Australia' then 'stale_register'
    else 'discovery_proxy'
  end,
  min(coalesce(jobs.created_at, now()))
from jobs
where jobs.country in ('Australia', 'Germany', 'Netherlands', 'Ireland', 'Sweden', 'Denmark', 'Japan', 'UAE')
group by jobs.country
on conflict (country) do nothing;

create table if not exists collection_runs (
  run_id text primary key,
  source_id text not null,
  country text not null,
  started_at timestamptz not null,
  finished_at timestamptz,
  ok boolean not null default false,
  error text,
  progress jsonb not null default '{}'::jsonb,
  payload jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists collection_runs_source_id_updated_idx
  on collection_runs (source_id, updated_at desc);

alter table tracked_countries enable row level security;
alter table collection_runs enable row level security;

drop policy if exists "authenticated users can manage tracked countries" on tracked_countries;
create policy "authenticated users can manage tracked countries"
  on tracked_countries for all to authenticated using (true) with check (true);

drop policy if exists "authenticated users can manage collection runs" on collection_runs;
create policy "authenticated users can manage collection runs"
  on collection_runs for all to authenticated using (true) with check (true);
