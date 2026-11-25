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

create index jobs_status_idx on jobs(status);
create index jobs_country_idx on jobs(country);
create index jobs_visa_confidence_idx on jobs(visa_confidence);
create index companies_country_idx on companies(country);
create index people_company_id_idx on people(company_id);
create index drafts_job_id_idx on drafts(job_id);
