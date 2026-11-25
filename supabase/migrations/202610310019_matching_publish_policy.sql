-- Enforce the active policy at publication, including claims from older deployments.
create or replace function public.publish_account_matches(p_user uuid,p_token uuid,p_summary jsonb,p_count integer) returns boolean
language plpgsql security definer set search_path='' as $$
declare s public.account_match_state; v integer;
begin
  select version into v from public.account_profiles where user_id=p_user for share;
  select * into s from public.account_match_state where user_id=p_user for update;
  if s.generation=p_token then return true; end if;
  if s.token is distinct from p_token or s.lease_until<=now() then return false; end if;
  -- An older deployment can claim again after activation fenced its first run.
  -- Do not let that process replace a published OSS generation with legacy scores.
  if coalesce(p_summary->>'engineVersion','legacy-v1') is distinct from
    (select version from public.matching_engine_policy where singleton) then
    raise exception 'Matching engine policy superseded';
  end if;
  if s.building_version is distinct from v then
    update public.account_match_state set token=null,lease_until=null where user_id=p_user;
    return false;
  end if;
  if (select count(*) from public.account_match_jobs where user_id=p_user and generation=p_token)<>p_count
    then raise exception 'Incomplete matching generation'; end if;
  update public.account_match_state set generation=p_token,profile_version=v,catalog_revision=s.building_revision,
    computed_at=now(),summary=p_summary,token=null,lease_until=null,retry_at=null,failed=false where user_id=p_user;
  delete from public.account_match_jobs where user_id=p_user and generation<>p_token;
  return true;
end $$;
