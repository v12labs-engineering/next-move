-- Polling must not execute the filtered match set and its counts.
create function public.read_account_matching_status() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare u uuid:=auth.uid(); s public.account_match_state; v integer;
begin
  if u is null then raise exception 'Authentication required'; end if;
  select version into v from public.account_profiles where user_id=u;
  if v is null then raise exception 'Complete your profile first'; end if;
  select * into s from public.account_match_state where user_id=u;
  return jsonb_build_object('generation',s.generation,'matching',jsonb_build_object(
    'status',case when s.failed then 'failed' when s.token is not null and s.lease_until>now() then 'running'
      when s.profile_version=v then 'ready' else 'pending' end,
    'stale',s.profile_version is distinct from v or s.catalog_revision is distinct from public.account_matching_revision(u)
      or s.computed_at is null or s.computed_at<now()-interval '6 hours',
    'computedAt',s.computed_at,'retryAt',s.retry_at,'engineVersion',coalesce(s.summary->>'engineVersion','legacy-v1')));
end $$;
revoke all on function public.read_account_matching_status() from public,anon;
grant execute on function public.read_account_matching_status() to authenticated;
