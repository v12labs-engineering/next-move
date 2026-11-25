-- Separate the initial and continuation queries so cached plans can use the
-- archive queue's ID range directly instead of filtering a nullable OR cursor.
create or replace function public.archive_catalog_description_batch(p_limit integer default 128,p_after text default null) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare result jsonb;
begin
 if p_after is null then
  select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]') into result from
   (select id,description from public.job_catalog where description_ref is null and description<>''
    order by id limit least(greatest(p_limit,1),256)) x;
 else
  select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]') into result from
   (select id,description from public.job_catalog where description_ref is null and description<>'' and id>p_after
    order by id limit least(greatest(p_limit,1),256)) x;
 end if;
 return result;
end $$;
