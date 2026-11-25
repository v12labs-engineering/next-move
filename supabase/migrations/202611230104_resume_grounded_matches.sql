-- Fence in-flight builds and hide stale recommendations until the updated
-- scorer publishes. Keep the old generation available to the saved view.
update public.account_match_state
set profile_version=null, computed_at=null, token=null, building_version=null,
    lease_until=null, failed=false, retry_at=null
where user_id is not null;

-- Command search uses the all view. Apply the same recommendation gate to
-- untracked listings before counts, deduplication and pagination in both views.
do $$
declare original text; definition text;
begin
  original:=pg_get_functiondef('public.read_account_matches_for(uuid,jsonb)'::regprocedure);
  definition:=replace(original,
    'where (s.profile_version=v and job->''match''->>''inScope''=''true'')',
    $scope$where (s.profile_version=v and job->'match'->>'inScope'='true'
      and (status<>'new' or (job->'match'->>'relevant'='true'
        and job->'match'->>'reviewable'='true')))$scope$);
  if definition=original then raise exception 'Unexpected account match reader definition'; end if;
  execute definition;
end $$;
