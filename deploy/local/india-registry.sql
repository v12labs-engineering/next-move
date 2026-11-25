begin;

create table if not exists public.registry_snapshot (
  sha256 text primary key check (sha256 ~ '^[a-f0-9]{64}$'),
  as_of date not null,
  source_url text not null check (source_url like 'https://%'),
  attribution text not null,
  imported_at timestamptz not null default now(),
  input_rows bigint not null,
  accepted_rows bigint not null,
  distinct_registrations bigint not null
);

create table if not exists public.registry_company (
  registration_id text primary key check (registration_id ~ '^[A-Z0-9-]{3,40}$'),
  legal_name text not null,
  name_key text not null check (name_key <> ''),
  company_status text,
  region text,
  city text,
  legal_form text,
  activity_hint text,
  snapshot_sha256 text not null references public.registry_snapshot(sha256),
  snapshot_date date not null
);
create index if not exists registry_company_name_lookup on public.registry_company (name_key);
alter table public.registry_company
  add column if not exists discovery_checked_at timestamptz,
  add column if not exists discovery_result text;
create index if not exists registry_company_discovery_order on public.registry_company
  (discovery_checked_at nulls first, registration_id) where lower(company_status) = 'active';

create table if not exists public.registry_company_link (
  registration_id text not null references public.registry_company(registration_id),
  kind text not null,
  url text not null check (url like 'https://%'),
  evidence_url text not null check (evidence_url like 'https://%'),
  evidence_source text not null,
  employer_key text not null,
  status text not null default 'pending' check (status in ('pending','public','restricted','deferred','unverified')),
  checked_at timestamptz,
  check_reason text,
  primary key (registration_id, kind, url)
);
alter table public.registry_company_link
  add column if not exists career_discovery_checked_at timestamptz,
  add column if not exists career_discovery_result text;
alter table public.registry_company_link
  drop constraint if exists registry_company_link_registration_id_fkey,
  add constraint registry_company_link_registration_id_fkey foreign key (registration_id)
    references public.registry_company(registration_id) on delete cascade,
  drop constraint if exists registry_company_link_kind_check,
  add constraint registry_company_link_kind_check
    check (kind in ('website', 'careers', 'park_listing'));
update public.registry_company_link
set kind = 'park_listing'
where kind = 'careers' and split_part(url, '/', 3) in
  ('infopark.in', 'www.infopark.in', 'infoparkjobs.in', 'www.infoparkjobs.in');

create index if not exists registry_career_links_pending on public.registry_company_link (registration_id, url)
  where kind = 'careers' and status = 'pending';

create table if not exists public.registry_feed_candidate (
  registration_id text not null references public.registry_company on delete cascade,
  source_id text not null,
  kind text not null,
  board text not null,
  evidence_url text not null,
  next_attempt_at timestamptz not null default now(),
  result text,
  primary key (registration_id, source_id)
);

create table if not exists public.registry_job_observation (
  registration_id text not null references public.registry_company on delete cascade,
  job_url text not null,
  title text not null,
  city text,
  posted_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (registration_id, job_url)
);

create table if not exists public.registry_hourly_run (
  id uuid primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  summary jsonb
);

commit;
