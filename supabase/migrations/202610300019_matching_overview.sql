-- Matching needs global summary counts and health only for selected destinations.
-- Return one JSON value so transport row limits cannot truncate source coverage.
create function public.catalog_matching_overview(p_countries text[]) returns jsonb
language sql stable security definer set search_path='' as $$
  with health as materialized (
    select d.id,d.countries,d.enabled,s.last_success_at,s.last_started_at,
      s.last_error is not null as failed,s.last_complete as complete,
      coalesce(r.status in ('running','paused'),false) as pending
    from public.job_source_directory d
    left join public.job_catalog_sources s on s.id=d.id
    left join public.job_catalog_runs r on r.id=s.current_run
  )
  select jsonb_build_object(
    'totalJobs',(select count(*) from public.job_catalog where is_active),
    'lastUpdatedAt',max(last_success_at),
    'sources',count(*) filter (where enabled and last_success_at is not null),
    'failedSources',count(*) filter (where enabled and failed),
    'health',coalesce(jsonb_agg(to_jsonb(health) order by id)
      filter (where enabled and countries && p_countries),'[]'::jsonb)
  ) from health;
$$;
revoke all on function public.catalog_matching_overview(text[]) from public,anon;
grant execute on function public.catalog_matching_overview(text[]) to authenticated,service_role;
