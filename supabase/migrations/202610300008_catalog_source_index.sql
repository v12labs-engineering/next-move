-- Complete-snapshot expiry looks up active rows for one source. Without this
-- index each small publication scans the growing catalogue under the capacity
-- lock, causing other collectors to wait and hit their statement deadlines.
create index job_catalog_source_active_idx on public.job_catalog(source,id) where is_active;
