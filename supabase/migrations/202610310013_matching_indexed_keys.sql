-- First find a bounded set of IDs using a covering country/cursor index. Loading
-- wide metadata in that scan let the planner choose the global primary key and
-- filter entire destinations afterward, exceeding the authenticated timeout.
create index job_catalog_active_matching_cursor_idx on public.job_catalog(country,id)
  include(last_checked_at,discovered_at) where is_active;

create or replace function public.catalog_matching_batch(p_countries text[],p_before timestamptz,
  p_after text default null,p_limit integer default 5000) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare result jsonb;
begin
  execute $query$
    with matching_ids as materialized (
      select found.id
      from (select distinct unnest($1::text[]) as country) destinations
      cross join lateral (
        select j.id from public.job_catalog j
        where j.is_active and j.country=destinations.country
          and j.last_checked_at >= $2-interval '7 days' and j.discovered_at <= $2
          and ($3 is null or j.id > $3)
        order by j.id limit least(greatest(coalesce($4,5000),1),5000)+1
      ) found
      order by found.id limit least(greatest(coalesce($4,5000),1),5000)+1
    ), page as materialized (
      select listing.* from matching_ids selected
      cross join lateral (
        select id,title,company,country,city,url,work_mode,visa_signal,
          sponsorship_evidence,sponsor_verified,source,posted_at,last_checked_at,
          discovered_at,is_active
        from public.job_catalog j where j.id=selected.id limit 1
      ) listing
    )
    select jsonb_build_object(
      'items',(select coalesce(jsonb_agg(to_jsonb(items) order by items.id),'[]'::jsonb)
        from (select * from page order by id limit least(greatest(coalesce($4,5000),1),5000)) items),
      'hasMore',(select count(*)>least(greatest(coalesce($4,5000),1),5000) from page)
    )
  $query$ into result using p_countries,p_before,p_after,p_limit;
  return result;
end $$;
