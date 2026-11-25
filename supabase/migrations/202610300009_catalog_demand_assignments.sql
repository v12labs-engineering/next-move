-- Validated directory countries are the source assignment used for priority.
-- Do not rescan every historical job description-bearing heap for each batch.
-- This is a priority hint, never a claim of currently published supply.
create or replace function public.catalog_source_demand(p_after text default null,p_limit integer default 500)
returns table(source text,demand bigint)
language sql stable security definer set search_path='' as $$
  select d.id,count(*) from public.job_source_directory d
  join public.account_countries c on c.country=any(d.countries)
  where d.enabled and (p_after is null or d.id>p_after)
  group by d.id order by d.id limit least(greatest(p_limit,1),500);
$$;
revoke all on function public.catalog_source_demand(text,integer) from public,anon,authenticated;
grant execute on function public.catalog_source_demand(text,integer) to service_role;
