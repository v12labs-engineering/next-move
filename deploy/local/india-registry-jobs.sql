begin;

create table if not exists public.registry_job_scrape_source (
  run_id uuid not null,
  url text not null check (url like 'https://%'),
  company text not null,
  registration_ids text[] not null,
  outcome text not null default 'pending',
  reason text,
  listings_observed integer not null default 0,
  pages_read integer not null default 0,
  checked_at timestamptz,
  render_attempted boolean not null default false,
  primary key (run_id, url)
);

alter table public.registry_job_scrape_source
  add column if not exists map_attempted boolean not null default false;

create table if not exists public.registry_scraped_job (
  run_id uuid not null,
  posting_key text not null,
  source_url text not null,
  job_url text not null check (job_url like 'https://%'),
  title text not null,
  company text not null,
  location text,
  countries text[] not null default '{}',
  posted_at timestamptz,
  description text not null,
  evidence_url text not null check (evidence_url like 'https://%'),
  method text not null,
  observed_at timestamptz not null default now(),
  primary key (run_id, posting_key),
  foreign key (run_id, source_url)
    references public.registry_job_scrape_source (run_id, url) on delete cascade
);

commit;
