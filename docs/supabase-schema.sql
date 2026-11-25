create type visa_confidence as enum ('confirmed', 'strong', 'possible', 'weak', 'no');
create type pipeline_status as enum ('discovered', 'shortlisted', 'needs_tailoring', 'applied', 'follow_up_due', 'recruiter_replied', 'interviewing', 'offer', 'rejected', 'archived');

create table candidate_profiles (
  id text primary key default 'default',
  headline text not null,
  target_outcome text not null,
  positioning text not null,
  family_requirements jsonb not null default '[]'::jsonb,
  target_roles jsonb not null default '[]'::jsonb,
  proof_points jsonb not null default '[]'::jsonb,
  ai_endpoint text not null default 'http://127.0.0.1:8317/v1',
  ai_model text not null default 'gpt-5.5',
  stagehand_profile_root text not null default '/Users/sharathreddychalla/.v12labs-agents/profiles',
  base_resume_file_name text not null default '',
  base_resume_text text not null default '',
  base_resume_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table country_scores (
  id text primary key,
  country text not null,
  city text not null,
  score integer not null check (score between 0 and 100),
  safety integer not null,
  healthcare integer not null,
  childcare integer not null,
  spouse_rights integer not null,
  english_friendly integer not null,
  residence_path integer not null,
  cost_pressure text not null,
  notes text not null default ''
);

create table companies (
  id text primary key,
  name text not null,
  country text not null,
  city text not null,
  website text,
  careers_url text,
  sponsor_source text,
  sponsor_category text,
  official_source_url text,
  last_checked date,
  visa_signal visa_confidence not null default 'weak',
  hiring_history_signal text,
  relevance_score integer not null default 0,
  open_roles integer not null default 0,
  outreach_status text not null default 'not_started',
  confidence text not null default 'medium',
  notes text not null default ''
);

create table jobs (
  id text primary key,
  company_id text references companies(id) on delete set null,
  title text not null,
  country text not null,
  city text not null,
  work_mode text not null,
  source_url text,
  source_type text not null,
  role_type text not null,
  seniority text not null,
  visa_confidence visa_confidence not null default 'weak',
  relocation_signal text,
  salary text,
  job_score integer not null default 0,
  country_score integer not null default 0,
  status pipeline_status not null default 'discovered',
  resume_variant text,
  ai_fit_score integer,
  ai_visa_score integer,
  ai_overall_score integer,
  ai_summary text,
  ai_why jsonb,
  ai_risks jsonb,
  ai_last_analyzed_at timestamptz,
  application_date date,
  follow_up_date date,
  notes text not null default '',
  created_at timestamptz not null default now(),
  refreshed_at timestamptz not null default now()
);

create table people (
  id text primary key,
  company_id text references companies(id) on delete set null,
  name text not null,
  role text not null,
  source_url text,
  relationship_status text not null default 'unknown',
  last_contact_date date,
  next_follow_up_date date,
  notes text not null default ''
);

create table drafts (
  id text primary key,
  job_id text references jobs(id) on delete cascade,
  company_id text references companies(id) on delete cascade,
  person_id text references people(id) on delete set null,
  kind text not null,
  title text not null,
  body text not null,
  updated_at timestamptz not null default now()
);

create table applications (
  id text primary key,
  job_id text references jobs(id) on delete cascade,
  resume_variant text not null,
  cover_note text not null default '',
  applied_at date not null,
  next_follow_up_at date not null,
  status pipeline_status not null default 'applied',
  notes text not null default ''
);

create table source_connectors (
  id text primary key,
  name text not null,
  type text not null,
  country text,
  status text not null default 'not_configured',
  last_run text,
  found integer not null default 0,
  notes text not null default ''
);

create table prompt_templates (
  id text primary key,
  name text not null,
  kind text not null,
  prompt text not null
);

create table app_state (
  id text primary key default 'default',
  refresh_log jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

create table simple_state (
  id text primary key default 'default',
  state jsonb not null default '{"jobs":[],"trackedCountries":[]}'::jsonb,
  updated_at timestamptz not null default now()
);

create index jobs_status_idx on jobs(status);
create index jobs_country_idx on jobs(country);
create index jobs_visa_confidence_idx on jobs(visa_confidence);
create index companies_country_idx on companies(country);
create index people_company_id_idx on people(company_id);
create index drafts_job_id_idx on drafts(job_id);

create extension if not exists vector;

create table research_crawl_runs (
  id text primary key,
  app_state_id text not null default 'default',
  source_id text not null,
  source_name text not null,
  provider text not null default 'direct_fetch_fallback',
  started_at timestamptz not null,
  finished_at timestamptz not null,
  log text not null default '',
  seeds jsonb not null default '[]'::jsonb,
  companies jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table research_documents (
  id text primary key,
  app_state_id text not null default 'default',
  crawl_run_id text not null references research_crawl_runs(id) on delete cascade,
  company_id text,
  company_name text not null,
  country text not null,
  url text not null,
  canonical_url text not null,
  page_type text not null,
  title text not null default '',
  description text not null default '',
  headings jsonb not null default '[]'::jsonb,
  excerpt text not null default '',
  body_text text not null default '',
  discovered_at timestamptz not null,
  relocation_mentions integer not null default 0,
  visa_mentions integer not null default 0,
  ai_mentions integer not null default 0,
  engineering_mentions integer not null default 0
);

create table research_chunks (
  id text primary key,
  app_state_id text not null default 'default',
  crawl_run_id text not null references research_crawl_runs(id) on delete cascade,
  document_id text not null references research_documents(id) on delete cascade,
  company_id text,
  company_name text not null,
  country text not null,
  url text not null,
  sequence integer not null default 0,
  text text not null,
  embedding vector(256),
  embedding_json jsonb not null default '[]'::jsonb,
  embedding_model text not null default '',
  embedding_source text not null default 'fallback_hash',
  created_at timestamptz not null default now()
);

create table research_reports (
  id text primary key,
  app_state_id text not null default 'default',
  report_type text not null,
  company_name text,
  country text,
  question text not null,
  answer text not null,
  summary text not null default '',
  key_findings jsonb not null default '[]'::jsonb,
  risks jsonb not null default '[]'::jsonb,
  opportunities jsonb not null default '[]'::jsonb,
  citations jsonb not null default '[]'::jsonb,
  retrieval_count integer not null default 0,
  created_at timestamptz not null default now()
);

create index research_runs_started_idx on research_crawl_runs(started_at desc);
create index research_documents_company_idx on research_documents(company_name, country);
create index research_chunks_company_idx on research_chunks(company_name, country);
create index research_reports_created_idx on research_reports(created_at desc);

create or replace function match_research_chunks(
  query_embedding vector(256),
  match_count integer default 8,
  company_name_filter text default null,
  country_filter text default null
)
returns table (
  id text,
  company_id text,
  company_name text,
  country text,
  url text,
  text text,
  similarity double precision
)
language sql
stable
as $$
  select
    research_chunks.id,
    research_chunks.company_id,
    research_chunks.company_name,
    research_chunks.country,
    research_chunks.url,
    research_chunks.text,
    1 - (research_chunks.embedding <=> query_embedding) as similarity
  from research_chunks
  where research_chunks.embedding is not null
    and (company_name_filter is null or research_chunks.company_name = company_name_filter)
    and (country_filter is null or research_chunks.country = country_filter)
  order by research_chunks.embedding <=> query_embedding
  limit greatest(match_count, 1);
$$;
