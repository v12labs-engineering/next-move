-- Aggregate operator telemetry only. No applicant data, tokens or job evidence.
create function public.matching_operational_status() returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'measuredAt',now(), 'databaseBytes',pg_database_size(current_database()),
    'budgetBytes',(select budget_bytes from public.catalog_capacity_control where singleton),
    'maxWorkers',(select max_workers from public.matching_capacity where singleton),
    'activeWorkers',(select count(*) from public.account_match_state where token is not null and lease_until>now()),
    'queuedAccounts',(select count(*) from public.account_match_state where queued_at is not null),
    'oldestQueueMs',(select coalesce(max(extract(epoch from(now()-queued_at))*1000),0) from public.account_match_state where queued_at is not null),
    'expiredWorkers',(select count(*) from public.account_match_state where token is not null and lease_until<=now()),
    'failedAccounts',(select count(*) from public.account_match_state where failed),
    'relations',(select jsonb_object_agg(name,jsonb_build_object('totalBytes',pg_total_relation_size(('public.'||name)::regclass),
      'indexBytes',pg_indexes_size(('public.'||name)::regclass))) from unnest(array[
      'account_match_jobs','account_match_batches','match_listing_snapshots','catalog_matching_features','catalog_matching_titles','job_catalog'
    ]) name)
  );
$$;
revoke all on function public.matching_operational_status() from public,anon,authenticated;
grant execute on function public.matching_operational_status() to service_role;
