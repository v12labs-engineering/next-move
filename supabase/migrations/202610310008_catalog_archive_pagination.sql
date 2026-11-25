-- Disjoint keyset pages allow a bounded migration pipeline without duplicate work.
drop function public.archive_catalog_description_batch(integer);
create function public.archive_catalog_description_batch(p_limit integer default 128,p_after text default null) returns jsonb
language sql stable security invoker set search_path='' as $$
 select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]') from
   (select id,description from public.job_catalog where description_ref is null and description<>''
     and (p_after is null or id>p_after)
     order by id limit least(greatest(p_limit,1),256)) x;
$$;
revoke all on function public.archive_catalog_description_batch(integer,text) from public,anon,authenticated;
grant execute on function public.archive_catalog_description_batch(integer,text) to service_role;
