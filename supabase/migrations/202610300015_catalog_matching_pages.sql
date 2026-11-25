-- Bounded metadata batches avoid one network round trip per 1,000 listings.
-- JSON aggregation is one result, so PostgREST's row cap cannot truncate a page.
create index job_catalog_active_country_id_idx on public.job_catalog(country,id) where is_active;
create function public.catalog_matching_page(p_countries text[],p_before timestamptz,
  p_after text default null,p_limit integer default 5000) returns jsonb
language sql stable security invoker set search_path='' as $$
  select coalesce(jsonb_agg(to_jsonb(page) order by page.id),'[]'::jsonb)
  from (
    select id,title,company,country,city,url,work_mode,visa_signal,
      sponsorship_evidence,sponsor_verified,source,posted_at,last_checked_at,
      discovered_at,is_active
    from public.job_catalog
    where is_active and country=any(p_countries)
      and last_checked_at>=p_before-interval '7 days' and discovered_at<=p_before
      and (p_after is null or id>p_after)
    order by id limit least(greatest(coalesce(p_limit,5000),1),5000)
  ) page;
$$;
revoke all on function public.catalog_matching_page(text[],timestamptz,text,integer) from public,anon;
grant execute on function public.catalog_matching_page(text[],timestamptz,text,integer) to authenticated,service_role;
