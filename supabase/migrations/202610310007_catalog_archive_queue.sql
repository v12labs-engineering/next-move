-- A measured full-table sort took eight seconds for one 128-row archive batch.
-- Keep the backfill bounded as it advances through the remaining descriptions.
create index job_catalog_description_archive_queue_idx on public.job_catalog(id) where description_ref is null;
create or replace function public.archive_catalog_description_batch(p_limit integer default 128) returns jsonb
language sql stable security invoker set search_path='' as $$
 select coalesce(jsonb_agg(to_jsonb(x)),'[]') from
   (select id,description from public.job_catalog where description_ref is null and description<>''
     order by id limit least(greatest(p_limit,1),256)) x;
$$;
