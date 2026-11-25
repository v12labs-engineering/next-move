-- Scheduler admission and health repeatedly check for India listings by source.
-- Index the actual listings, including inactive rows used as historical evidence.
create index if not exists job_catalog_india_source_idx
  on public.job_catalog(source) where country = 'India';
