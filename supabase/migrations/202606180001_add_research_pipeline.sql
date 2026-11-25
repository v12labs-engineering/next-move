create extension if not exists vector;

create table if not exists research_crawl_runs (
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

create table if not exists research_documents (
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

create table if not exists research_chunks (
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

create table if not exists research_reports (
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

create index if not exists research_runs_started_idx on research_crawl_runs(started_at desc);
create index if not exists research_documents_company_idx on research_documents(company_name, country);
create index if not exists research_chunks_company_idx on research_chunks(company_name, country);
create index if not exists research_reports_created_idx on research_reports(created_at desc);

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
