-- Country sizes differ substantially, and the optional cursor changes the best
-- index bounds. Plan with the actual destination/cursor on each call instead of
-- reusing the SQL function's parameter-blind plan (live statement timeout 57014).
-- Bound parameters keep values out of SQL text; invoker rights preserve RLS.
create or replace function public.catalog_matching_batch(p_countries text[],p_before timestamptz,
  p_after text default null,p_limit integer default 5000) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare result jsonb;
begin
  execute $query$
    with page as materialized (
      select id,title,company,country,city,url,work_mode,visa_signal,
        sponsorship_evidence,sponsor_verified,source,posted_at,last_checked_at,
        discovered_at,is_active
      from public.job_catalog
      where is_active and country=any($1)
        and last_checked_at >= $2-interval '7 days' and discovered_at <= $2
        and ($3 is null or id > $3)
      order by id limit least(greatest(coalesce($4,5000),1),5000)+1
    )
    select jsonb_build_object(
      'items',(select coalesce(jsonb_agg(to_jsonb(items) order by items.id),'[]'::jsonb)
        from (select * from page order by id limit least(greatest(coalesce($4,5000),1),5000)) items),
      'hasMore',(select count(*)>least(greatest(coalesce($4,5000),1),5000) from page)
    )
  $query$ into result using p_countries,p_before,p_after,p_limit;
  return result;
end $$;
