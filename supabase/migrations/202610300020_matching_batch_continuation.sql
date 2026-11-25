-- Explicit continuation avoids a final empty database request per destination.
-- The JSON envelope also preserves continuation across transport row limits.
create function public.catalog_matching_batch(p_countries text[],p_before timestamptz,
  p_after text default null,p_limit integer default 5000) returns jsonb
language sql stable security invoker set search_path='' as $$
  with page as materialized (
    select id,title,company,country,city,url,work_mode,visa_signal,
      sponsorship_evidence,sponsor_verified,source,posted_at,last_checked_at,
      discovered_at,is_active
    from public.job_catalog
    where is_active and country=any(p_countries)
      and last_checked_at>=p_before-interval '7 days' and discovered_at<=p_before
      and (p_after is null or id>p_after)
    order by id limit least(greatest(coalesce(p_limit,5000),1),5000)+1
  )
  select jsonb_build_object(
    'items',(select coalesce(jsonb_agg(to_jsonb(items) order by items.id),'[]'::jsonb)
      from (select * from page order by id limit least(greatest(coalesce(p_limit,5000),1),5000)) items),
    'hasMore',(select count(*)>least(greatest(coalesce(p_limit,5000),1),5000) from page)
  );
$$;
revoke all on function public.catalog_matching_batch(text[],timestamptz,text,integer) from public,anon;
grant execute on function public.catalog_matching_batch(text[],timestamptz,text,integer) to authenticated,service_role;
