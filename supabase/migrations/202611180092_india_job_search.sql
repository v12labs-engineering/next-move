-- Move existing profiles to the India catalogue and invalidate old match scores.
-- Keep account job states, applications, and country-specific application answers.
with changed_profiles as materialized (
  select p.user_id
  from public.account_profiles p
  where not exists (
    select 1 from public.account_countries c
    where c.user_id=p.user_id and c.country='India'
  ) or exists (
    select 1 from public.account_countries c
    where c.user_id=p.user_id and c.country<>'India'
  )
), updated_profiles as (
  update public.account_profiles p
  set data=case when jsonb_typeof(p.data->'targetLocations')='array' then
      jsonb_set(p.data,'{targetLocations}',(
        select coalesce(jsonb_agg(location order by position),'[]'::jsonb)
        from jsonb_array_elements(p.data->'targetLocations') with ordinality as places(location,position)
        where location->>'country'='India'
      ))
    else p.data end,
    version=p.version+1,
    updated_at=now()
  from changed_profiles changed
  where p.user_id=changed.user_id
  returning p.user_id
), removed_countries as (
  delete from public.account_countries c
  using updated_profiles p
  where c.user_id=p.user_id and c.country<>'India'
)
insert into public.account_countries(user_id,country)
select user_id,'India' from updated_profiles
on conflict (user_id,country) do nothing;
