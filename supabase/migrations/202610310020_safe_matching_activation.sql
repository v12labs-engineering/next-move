-- Supabase safe-update mode requires an explicit predicate even for intentional policy-wide invalidation.
create or replace function public.activate_matching_engine(p_version text) returns void
language plpgsql security invoker set search_path='' as $$
declare previous text;
begin
  if p_version !~ '^(legacy-v1|oss-[a-z0-9-]{1,80})$' then raise exception 'Invalid matching policy'; end if;
  select version into strict previous from public.matching_engine_policy where singleton for update;
  if previous=p_version then return; end if;
  update public.matching_engine_policy set version=p_version where singleton;
  -- Preserve published generations, but fence every worker using the old policy.
  update public.account_match_state set token=null,building_version=null,lease_until=null,
    computed_at=null,failed=false,retry_at=null where user_id is not null;
end $$;
revoke all on function public.activate_matching_engine(text) from public,anon,authenticated;
grant execute on function public.activate_matching_engine(text) to service_role;
