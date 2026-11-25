-- Deduplicate public listing metadata across account score generations. Private
-- assessment evidence remains in each account's RLS-protected score row.
create table public.match_listing_snapshots (
  id text primary key check(id ~ '^[a-f0-9]{64}$'),
  data jsonb not null
);
alter table public.match_listing_snapshots enable row level security;
revoke all on public.match_listing_snapshots from public,anon,authenticated;
grant select on public.match_listing_snapshots to service_role;
alter table public.account_match_jobs add column listing_key text references public.match_listing_snapshots(id);
create index account_match_listing_key_idx on public.account_match_jobs(listing_key) where listing_key is not null;

create function public.match_listing_data(j jsonb) returns jsonb
language sql immutable set search_path='' as $$
  select j-array['match','status','description','lastCheckedAt','freshness'];
$$;
create or replace function public.stage_account_matches(p_user uuid,p_token uuid,p_jobs jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare s public.account_match_state; budget bigint;
begin
  select * into s from public.account_match_state where user_id=p_user for update;
  if s.token is distinct from p_token or s.lease_until<=now() then raise exception 'Matching run superseded'; end if;
  if jsonb_array_length(p_jobs)>200 or octet_length(p_jobs::text)>4000000 then raise exception 'Matching batch too large'; end if;
  perform pg_advisory_xact_lock(730103006);
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

-- Bounded operator maintenance; no blocking table rewrite in this migration.
create function public.compact_account_matches(p_limit integer default 200) returns integer
language plpgsql security definer set search_path='' as $$
declare r record; k text; n integer:=0; budget bigint;
begin
  perform pg_advisory_xact_lock(730103006);
  select budget_bytes into strict budget from public.catalog_capacity_control where singleton;
  if pg_database_size(current_database())+4000000>budget then raise exception 'Matching compaction needs storage headroom'; end if;
  for r in select user_id,generation,job_id,job from public.account_match_jobs where listing_key is null
    limit least(200,greatest(1,p_limit)) for update skip locked loop
    k:=encode(sha256(convert_to(public.match_listing_data(r.job)::text,'UTF8')),'hex');
    insert into public.match_listing_snapshots values(k,public.match_listing_data(r.job)) on conflict do nothing;
    update public.account_match_jobs set listing_key=k,
      job=jsonb_build_object('id',r.job->'id','country',r.job->'country','match',r.job->'match','lastCheckedAt',r.job->'lastCheckedAt')
      where user_id=r.user_id and generation=r.generation and job_id=r.job_id;
    n:=n+1;
  end loop;
  return n;
end $$;
create function public.prune_match_snapshots(p_limit integer default 200) returns integer
language plpgsql security definer set search_path='' as $$
declare n integer;
begin
  -- Use the same storage lock as staging to avoid deleting a just-created snapshot.
  perform pg_advisory_xact_lock(730103006);
  delete from public.match_listing_snapshots where id in (
    select s.id from public.match_listing_snapshots s where not exists (
      select 1 from public.account_match_jobs m where m.listing_key=s.id
    ) limit least(1000,greatest(1,p_limit)) for update of s skip locked
  );
  get diagnostics n=row_count;
  return n;
end $$;
revoke all on function public.match_listing_data(jsonb),public.compact_account_matches(integer),public.prune_match_snapshots(integer) from public,anon,authenticated;
grant execute on function public.compact_account_matches(integer),public.prune_match_snapshots(integer) to service_role;

create or replace function public.read_account_matches_for(p_user uuid,p_filters jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path='' set plan_cache_mode='force_custom_plan' as $$
declare u uuid:=p_user; s public.account_match_state; v integer; r bigint; result jsonb;
  lim integer:=least(200,greatest(1,coalesce((p_filters->>'limit')::integer,25)));
  off integer:=greatest(0,coalesce((p_filters->>'offset')::integer,0));
begin
  if u is null then raise exception 'Authentication required'; end if;
  select version into v from public.account_profiles where user_id=u;
  if v is null then raise exception 'Complete your profile first'; end if;
  select * into s from public.account_match_state where user_id=u;
  if p_filters->>'generation' is not null and (p_filters->>'generation')::uuid is distinct from s.generation then off:=0; end if;
  r:=public.account_matching_revision(u);
  with owned_scores as materialized (
    select coalesce(l.data,'{}'::jsonb) || m.job as job,m.score,m.job_id,m.country from public.account_match_jobs m
    left join public.match_listing_snapshots l on l.id=m.listing_key
    where m.user_id=u and m.generation=s.generation and s.profile_version=v
      and (p_filters->'jobIds' is null or p_filters->'jobIds' ? m.job_id)
  ), scored as materialized (
    select m.job || jsonb_build_object('status',coalesce(a.status,'new'),'isActive',coalesce(c.is_active,false),
      'lastCheckedAt',coalesce(c.last_checked_at,(m.job->>'lastCheckedAt')::timestamptz),
      'freshness',case when (m.job->>'postedDate')::timestamptz>=now()-interval '3 days' then 'fresh'
        when (m.job->>'postedDate')::timestamptz>=now()-interval '30 days' then 'ok' else 'stale' end) as job,
      m.score,m.job_id,m.country,coalesce(a.status,'new') as status,
      min((m.job->>'seenAt')::timestamptz) over(partition by m.job->>'url') as first_seen,
      (m.job->>'postedDate')::timestamptz between
        now()-case when p_filters->>'datePosted'='month' then interval '30 days' else interval '7 days' end
        and now() as within_window,
      coalesce(c.is_active and c.last_checked_at>=now()-interval '7 days',false) as active
    from owned_scores m
    left join lateral (
      -- Use the existing covering active-country/cursor index; no wide listing
      -- heap read is needed for availability across the complete match set.
      select true as is_active,j.last_checked_at from public.job_catalog j
      where j.country=m.country and j.id=m.job_id and j.is_active limit 1
    ) c on true
    left join lateral (
      select a.status from public.account_job_states a
      where a.user_id=u and a.job_id=m.job_id limit 1
    ) a on true
  ), filtered as materialized (
    select * from scored
    where (coalesce(p_filters->>'country','all')='all' or country=p_filters->>'country')
      and (coalesce(p_filters->>'view','jobs')='all'
        or (p_filters->>'view'='saved' and status<>'new')
        or (coalesce(p_filters->>'view','jobs')='jobs'
          and country in(select country from public.account_countries where user_id=u)
          and coalesce((job->'match'->>'relevant')::boolean,true)
          and (coalesce((p_filters->>'hidden')::boolean,false) or status not in ('applied','dismissed'))
          and (status<>'new' or (active and coalesce((job->'match'->>case when coalesce((p_filters->>'strict')::boolean,false) then 'eligible' else 'reviewable' end)::boolean,false)))))
      and (coalesce(p_filters->>'view','jobs')='saved' or status in ('interested','applied') or (within_window and active))
      and (p_filters->>'since' is null or first_seen>=(p_filters->>'since')::timestamptz)
      and (coalesce(p_filters->>'query','')='' or strpos(lower(concat_ws(' ',job->>'title',job->>'company',job->>'country',job->>'city')),lower(p_filters->>'query'))>0)
      and (coalesce(p_filters->>'visa','all')='all' or job->>'visaSignal'=p_filters->>'visa'
        or coalesce(p_filters->'visaExempt','[]') ? country)
  ), variants as (
    select *,row_number() over(partition by job->>'url' order by (status<>'new') desc,
      coalesce((job->'match'->>'eligible')::boolean,false) desc,
      coalesce((job->'match'->>'reviewable')::boolean,false) desc,score desc,job_id) as variant
    from filtered
  ), deduplicated as materialized (
    select * from variants where variant=1
  ), ordered as (
    select *,row_number() over(order by
      case when p_filters->>'sort'='newest' then (job->>'postedDate')::timestamptz end desc nulls last,
      coalesce((job->'match'->>'eligible')::boolean,false) desc,score desc,coalesce((job->'match'->'assessment'->>'retrievalScore')::double precision,0) desc,job_id) as position
    from deduplicated
  ), page as (select * from ordered order by position limit lim offset off)
  select jsonb_build_object('profileVersion',v,'generation',s.generation,'jobs',coalesce((select jsonb_agg(job order by position) from page),'[]'),
    'total',(select count(*) from deduplicated),'offset',off,'limit',lim,
    'counts',jsonb_build_object('toReview',(select count(*) from deduplicated where status='new'),
      'confirmed',(select count(*) from deduplicated where job->>'visaSignal'='confirmed' and not(coalesce(p_filters->'visaExempt','[]') ? country)),
      'fresh',(select count(*) from deduplicated where (job->>'postedDate')::timestamptz between now()-interval '3 days' and now()),
      'new',(select count(*) from scored where status='new' and within_window and active and country in(select country from public.account_countries where user_id=u)
        and coalesce((job->'match'->>'reviewable')::boolean,false)))) into result;
  return result || jsonb_build_object('catalog',case when s.profile_version=v then s.summary->'catalog' else null end,
    'matching',jsonb_build_object('status',case when s.failed then 'failed' when s.token is not null and s.lease_until>now() then 'running'
      when s.profile_version=v then 'ready' else 'pending' end,
      'stale',s.profile_version is distinct from v or s.catalog_revision is distinct from r or s.computed_at is null or s.computed_at<now()-interval '6 hours',
      'computedAt',s.computed_at,'retryAt',s.retry_at,'engineVersion',coalesce(s.summary->>'engineVersion','legacy-v1')));
end $$;

revoke all on function public.read_account_matches_for(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.read_account_matches_for(uuid,jsonb) to service_role;
create or replace function public.read_account_matches(p_filters jsonb default '{}') returns jsonb
language sql stable security definer set search_path='' as $$
  select public.read_account_matches_for(auth.uid(),p_filters);
$$;
revoke all on function public.read_account_matches(jsonb) from public,anon;
grant execute on function public.read_account_matches(jsonb) to authenticated;
