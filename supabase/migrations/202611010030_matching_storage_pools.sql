-- Separate matching growth from ingestion; the existing physical database cap remains authoritative.
-- Defaults allocate 25% to public features and 40% to scores/checkpoints, leaving
-- 35% for catalog, application data, other tables and headroom. Operators may lower
-- these limits; this migration never increases the database allowance.
create table public.matching_storage_limits (
 singleton boolean primary key default true check(singleton),
 feature_bytes bigint not null check(feature_bytes>0),
 account_bytes bigint not null check(account_bytes>0)
);
insert into public.matching_storage_limits
 select true,budget_bytes/4,budget_bytes*2/5 from public.catalog_capacity_control where singleton;
alter table public.matching_storage_limits enable row level security;
revoke all on public.matching_storage_limits from public,anon,authenticated;
grant select,update on public.matching_storage_limits to service_role;

create function public.matching_storage_pools() returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
  'features',jsonb_build_object('usedBytes',
    pg_total_relation_size('public.catalog_matching_features')+pg_total_relation_size('public.catalog_matching_titles'),
    'limitBytes',least(l.feature_bytes,c.budget_bytes/4)),
  'accounts',jsonb_build_object('usedBytes',
    pg_total_relation_size('public.account_match_jobs')+pg_total_relation_size('public.account_match_batches')+
    pg_total_relation_size('public.account_match_state')+pg_total_relation_size('public.match_listing_snapshots'),
    'limitBytes',least(l.account_bytes,c.budget_bytes*2/5)))
 from public.matching_storage_limits l cross join public.catalog_capacity_control c where l.singleton and c.singleton;
$$;
revoke all on function public.matching_storage_pools() from public,anon,authenticated;
grant execute on function public.matching_storage_pools() to service_role;

create function public.enforce_matching_storage_pool(p_pool text,p_payload_bytes bigint) returns void
language plpgsql security definer set search_path='' as $$
declare pool jsonb;
begin
 if p_pool not in ('features','accounts') or p_pool is null or p_payload_bytes is null or p_payload_bytes<0 then raise exception 'Invalid matching storage pool'; end if;
 perform pg_advisory_xact_lock(730103006);
 pool:=public.matching_storage_pools()->p_pool;
 if pool is null or (pool->>'usedBytes')::bigint+p_payload_bytes*3>(pool->>'limitBytes')::bigint then
   raise exception 'Matching % storage budget reached',p_pool;
 end if;
end $$;
revoke all on function public.enforce_matching_storage_pool(text,bigint) from public,anon,authenticated;
grant execute on function public.enforce_matching_storage_pool(text,bigint) to service_role;

create or replace function public.cache_matching_features(p_rows jsonb) returns void
language plpgsql security invoker set search_path='' as $$
declare budget bigint;
begin
  if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)>20 or octet_length(p_rows::text)>2000000
    then raise exception 'Invalid matching features batch'; end if;
  if exists(select 1 from jsonb_array_elements(p_rows) x where
    coalesce(x->>'source_hash','') !~ '^[a-f0-9]{64}$' or coalesce(x->>'title_hash','') !~ '^[a-f0-9]{64}$' or length(coalesce(x->>'search_text',''))>150000
    or x->'features'->>'version' is distinct from x->>'engine_version'
    or jsonb_typeof(x->'features'->'requirements') is distinct from 'array'
    or jsonb_array_length(x->'features'->'requirements')>64
    or jsonb_typeof(x->'features'->'embedding') is distinct from 'array'
    or jsonb_typeof(x->'features'->'titleEmbedding') is distinct from 'array'
    or jsonb_array_length(x->'features'->'embedding')<>384
    or jsonb_array_length(x->'features'->'titleEmbedding')<>1024)
    then raise exception 'Invalid matching features'; end if;
  -- Share the collector's existing capacity lock and budget; never upgrade allowances.
  perform pg_catalog.pg_advisory_xact_lock(730103006);
  perform public.enforce_matching_storage_pool('features',octet_length(p_rows::text)::bigint);
  select budget_bytes into strict budget from public.catalog_capacity_control where singleton;
  if pg_database_size(current_database())+octet_length(p_rows::text)::bigint*3>budget
    then raise exception 'Matching feature storage budget reached'; end if;
  insert into public.catalog_matching_titles(title_hash,engine_version,embedding)
    select distinct on (x->>'title_hash') x->>'title_hash',x->>'engine_version',
      array(select value::real from jsonb_array_elements_text(x->'features'->'titleEmbedding') with ordinality as a(value,n) order by n)
    from jsonb_array_elements(p_rows) x
    on conflict(title_hash) do nothing;
  insert into public.catalog_matching_features(job_id,source_hash,engine_version,search_text,features,embedding,title_hash)
    select x->>'job_id',x->>'source_hash',x->>'engine_version',x->>'search_text',(x->'features')-array['embedding','titleEmbedding'],
      array(select value::real from jsonb_array_elements_text(x->'features'->'embedding') with ordinality as a(value,n) order by n),x->>'title_hash'
    from jsonb_array_elements(p_rows) x
    on conflict(job_id) do update set source_hash=excluded.source_hash,engine_version=excluded.engine_version,
      search_text=excluded.search_text,features=excluded.features,embedding=excluded.embedding,title_hash=excluded.title_hash,updated_at=now();
end $$;

create or replace function public.checkpoint_account_match_batch(p_user uuid,p_token uuid,p_batch integer,p_next jsonb,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.account_match_state; budget bigint;
begin
  select * into s from public.account_match_state where user_id=p_user for update;
  if s.token is distinct from p_token or s.lease_until<=now() then raise exception 'Matching run superseded'; end if;
  if (s.build_cursor->>'batch')::integer>p_batch then return s.build_cursor; end if;
  if (s.build_cursor->>'batch')::integer is distinct from p_batch
    or (p_next->>'batch')::integer is distinct from p_batch+1
    or p_next->>'token' is distinct from p_token::text then raise exception 'Invalid matching checkpoint'; end if;
  if octet_length(p_payload::text)>2000000 or jsonb_array_length(p_payload->'jobs')>200
    or exists(select 1 from jsonb_array_elements(p_payload->'jobs') j where j ? 'description')
    then raise exception 'Invalid matching batch'; end if;
  perform pg_advisory_xact_lock(730103006);
  perform public.enforce_matching_storage_pool('accounts',octet_length(p_payload::text)::bigint);
  select budget_bytes into strict budget from public.catalog_capacity_control where singleton;
  if pg_database_size(current_database())+octet_length(p_payload::text)::bigint*3>budget then
    raise exception 'Matching checkpoint storage budget reached'; end if;
  insert into public.account_match_batches values(p_user,p_token,p_batch,p_payload);
  update public.account_match_state set build_cursor=p_next,lease_until=now()+interval '10 minutes' where user_id=p_user;
  return p_next;
end $$;

create or replace function public.stage_account_matches(p_user uuid,p_token uuid,p_jobs jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare s public.account_match_state; budget bigint;
begin
  select * into s from public.account_match_state where user_id=p_user for update;
  if s.token is distinct from p_token or s.lease_until<=now() then raise exception 'Matching run superseded'; end if;
  if jsonb_array_length(p_jobs)>200 or octet_length(p_jobs::text)>4000000 then raise exception 'Matching batch too large'; end if;
  perform pg_advisory_xact_lock(730103006);
  perform public.enforce_matching_storage_pool('accounts',octet_length(p_jobs::text)::bigint);
  select budget_bytes into strict budget from public.catalog_capacity_control where singleton;
  if pg_database_size(current_database())+octet_length(p_jobs::text)::bigint*3>budget then raise exception 'Matching score storage budget reached'; end if;
  insert into public.match_listing_snapshots(id,data)
    select distinct encode(sha256(convert_to(public.match_listing_data(j)::text,'UTF8')),'hex'),public.match_listing_data(j)
    from jsonb_array_elements(p_jobs) j on conflict do nothing;
  insert into public.account_match_jobs(user_id,generation,job_id,job,listing_key)
    select p_user,p_token,j->>'id',jsonb_build_object('id',j->'id','country',j->'country','match',j->'match','lastCheckedAt',j->'lastCheckedAt'),
      encode(sha256(convert_to(public.match_listing_data(j)::text,'UTF8')),'hex')
    from jsonb_array_elements(p_jobs) j
    on conflict(user_id,generation,job_id) do update set job=excluded.job,listing_key=excluded.listing_key;
  update public.account_match_state set lease_until=now()+interval '10 minutes' where user_id=p_user;
end $$;

-- The FK does not create this referencing index automatically.
create index catalog_matching_features_title_idx on public.catalog_matching_features(title_hash);
create function public.prune_matching_titles(p_limit integer default 500) returns integer
language plpgsql security definer set search_path='' as $$
declare n integer;
begin
 perform pg_advisory_xact_lock(730103006);
 delete from public.catalog_matching_titles where title_hash in (
  select t.title_hash from public.catalog_matching_titles t
  where not exists(select 1 from public.catalog_matching_features f where f.title_hash=t.title_hash)
  order by t.title_hash limit least(500,greatest(1,p_limit))
 );
 get diagnostics n=row_count;
 return n;
end $$;
revoke all on function public.prune_matching_titles(integer) from public,anon,authenticated;
grant execute on function public.prune_matching_titles(integer) to service_role;

-- Aggregate operator telemetry only. No applicant data, tokens or job evidence.
create or replace function public.matching_operational_status() returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'storagePools',public.matching_storage_pools(),
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
