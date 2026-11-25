-- Preferences stay in the existing account-owned profile JSON. Invalidate old
-- classifications and fence workers; preserve listings and saved history.
update public.account_match_state
set token=null,building_version=null,lease_until=null,computed_at=null,
    failed=false,retry_at=null,summary=null
where user_id is not null;

do $$
declare definition text; updated text;
begin
  definition:=pg_get_functiondef('public.read_account_matches_for(uuid,jsonb)'::regprocedure);
  updated:=replace(definition,
    'where job->''match''->>''softwareRole''=''true''',
    'where (s.profile_version=v and job->''match''->>''inScope''=''true'')');
  if updated=definition then raise exception 'Unexpected match reader definition; review before migration'; end if;
  execute updated;

  definition:=pg_get_functiondef('public.automatic_discovery_country_priority()'::regprocedure);
  updated:=replace(definition, '->>''softwareRole''', '->>''inScope''');
  if updated=definition then raise exception 'Unexpected discovery priority definition; review before migration'; end if;
  execute updated;
end $$;
