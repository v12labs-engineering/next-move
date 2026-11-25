-- A scoped refresh must not scan/download the full source directory, health,
-- country demand and availability on every small background batch.
create function public.catalog_collection_sources(p_ids text[]) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
begin
 if p_ids is null or cardinality(p_ids)>100 then raise exception 'Use at most 100 source IDs'; end if;
 return (
  select coalesce(jsonb_agg(to_jsonb(selected) order by selected.id),'[]'::jsonb) from (
   select d.id,d.kind,d.company,d.board,d.countries,d.enabled,
    s.last_success_at,s.last_started_at,s.last_error is not null as failed,
    s.last_complete as complete,coalesce(r.status in ('running','paused'),false) as pending,
    s.lease_until,case when r.status<>'succeeded' then r.retry_at end as retry_at
   from public.job_source_directory d left join public.job_catalog_sources s on s.id=d.id
   left join public.job_catalog_runs r on r.id=s.current_run
   where d.enabled and d.id=any(p_ids)
  ) selected
 );
end $$;
revoke all on function public.catalog_collection_sources(text[]) from public,anon,authenticated;
grant execute on function public.catalog_collection_sources(text[]) to service_role;
