begin;

alter table public.registry_company_link
  add column if not exists job_map_checked_at timestamptz;

create index if not exists registry_job_map_due
  on public.registry_company_link (job_map_checked_at nulls first, registration_id, url)
  where kind = 'careers' and status = 'public';

alter table public.registry_job_observation
  add column if not exists source_method text not null default 'structured_data',
  add column if not exists evidence_url text,
  add column if not exists countries text[] not null default array['India']::text[];

commit;
