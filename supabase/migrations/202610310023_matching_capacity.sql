-- Scoped content revisions and a database-enforced admission limit.
-- Deploy before the checkpointed worker. Existing published generations remain readable.
create sequence public.matching_revision_sequence;
create table public.catalog_match_country_revision(country text primary key, revision bigint not null);
alter table public.catalog_match_country_revision enable row level security;
revoke all on public.catalog_match_country_revision from public,anon,authenticated;
grant select on public.catalog_match_country_revision to service_role;

-- Normalize archived/raw descriptions to the same content identity. Housekeeping
-- and successful unchanged checks must not invalidate everyone's scores.
create function public.matching_catalog_content(j jsonb) returns jsonb
language sql immutable set search_path='' as $$
  select (j-array['last_checked_at','updated_at','description','description_ref']) ||
    jsonb_build_object('descriptionHash',coalesce(j->'description_ref'->>'sha256',
      encode(sha256(convert_to(coalesce(j->>'description',''),'UTF8')),'hex')));
$$;
create function public.bump_matching_countries() returns trigger
language plpgsql security definer set search_path='' as $$
declare countries text[]; r bigint;
begin
  if TG_OP='INSERT' then select array_agg(distinct country) into countries from new_rows;
  elsif TG_OP='DELETE' then select array_agg(distinct country) into countries from old_rows;
  else
    select array_agg(distinct country) into countries from (
      select unnest(array[o.country,n.country]) as country from old_rows o join new_rows n using(id)
      where public.matching_catalog_content(to_jsonb(o)) is distinct from public.matching_catalog_content(to_jsonb(n))
        or (coalesce(o.last_checked_at<now()-interval '7 days',true) and n.last_checked_at>=now()-interval '7 days')
    ) changed;
  end if;
  if coalesce(cardinality(countries),0)=0 then return null; end if;
  r:=nextval('public.matching_revision_sequence');
  insert into public.catalog_match_country_revision(country,revision)
    select country,r from unnest(countries) country where country is not null order by country
    on conflict(country) do update set revision=greatest(public.catalog_match_country_revision.revision,excluded.revision);
  return null;
end $$;
drop trigger catalog_match_revision on public.job_catalog;
create trigger matching_insert after insert on public.job_catalog referencing new table as new_rows
  for each statement execute function public.bump_matching_countries();
create trigger matching_update after update on public.job_catalog referencing old table as old_rows new table as new_rows
  for each statement execute function public.bump_matching_countries();
create trigger matching_delete after delete on public.job_catalog referencing old table as old_rows
  for each statement execute function public.bump_matching_countries();
-- Start above old global revisions so an old generation cannot accidentally match.
select setval('public.matching_revision_sequence',greatest(1,(select revision+1 from public.catalog_match_revision)));
insert into public.catalog_match_country_revision
  select country,nextval('public.matching_revision_sequence') from public.job_catalog group by country;

create function public.account_matching_revision(p_user uuid) returns bigint
language sql stable security definer set search_path='' as $$
  select coalesce(max(revision),0) from public.catalog_match_country_revision
  where country in(select country from public.account_countries where user_id=p_user
    union select c.country from public.account_job_states s join public.job_catalog c on c.id=s.job_id where s.user_id=p_user);
$$;
create table public.matching_capacity (
  singleton boolean primary key default true check(singleton),
  max_workers integer not null default 2 check(max_workers between 1 and 16)
);
insert into public.matching_capacity default values;
alter table public.matching_capacity enable row level security;
revoke all on public.matching_capacity from public,anon,authenticated;
grant select,update on public.matching_capacity to service_role;
alter table public.account_match_state add column queued_at timestamptz, add column build_started_at timestamptz;
create index account_matching_active_lease_idx on public.account_match_state(lease_until) where token is not null;
create index account_matching_queue_idx on public.account_match_state(queued_at,user_id) where queued_at is not null;

create or replace function public.claim_account_matching(p_user uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.account_match_state; v integer; r bigint; capacity integer; waiting timestamptz;
begin
  -- All admissions share this short transaction lock; no inference holds it.
  perform pg_advisory_xact_lock(730103023);
  select version into v from public.account_profiles where user_id=p_user for share;
  if v is null then return null; end if;
  r:=public.account_matching_revision(p_user);
  insert into public.account_match_state(user_id) values(p_user) on conflict do nothing;
  select * into s from public.account_match_state where user_id=p_user for update;
  if s.token is not null and s.building_version=v and s.lease_until>now() then return null; end if;
  if s.profile_version=v and s.catalog_revision=r and s.computed_at>now()-interval '6 hours' then
    update public.account_match_state set queued_at=null where user_id=p_user;
    return null;
  end if;
  if s.retry_at>now() and s.building_version=v then return null; end if;
  waiting:=coalesce(s.queued_at,now());
  update public.account_match_state set queued_at=waiting where user_id=p_user;
  select max_workers into capacity from public.matching_capacity where singleton;
  if (select count(*) from public.account_match_state where token is not null and lease_until>now() and user_id<>p_user)>=capacity then return null; end if;
  delete from public.account_match_jobs where user_id=p_user and generation is distinct from s.generation;
  update public.account_match_state set token=gen_random_uuid(),building_version=v,building_revision=r,
    lease_until=now()+interval '10 minutes',retry_at=null,failed=false,queued_at=null,build_started_at=now()
    where user_id=p_user returning * into s;
  return jsonb_build_object('token',s.token,'profileVersion',v,'catalogRevision',r,
    'queueWaitMs',greatest(0,extract(epoch from(now()-waiting))*1000));
end $$;
revoke all on function public.account_matching_revision(uuid),public.matching_catalog_content(jsonb),public.bump_matching_countries() from public,anon,authenticated;
grant execute on function public.account_matching_revision(uuid) to service_role;

create or replace function public.read_account_matches(p_filters jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path='' set plan_cache_mode='force_custom_plan' as $$
declare u uuid:=auth.uid(); s public.account_match_state; v integer; r bigint; result jsonb;
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
    select m.job,m.score,m.job_id,m.country from public.account_match_jobs m
    where m.user_id=u and m.generation=s.generation and s.profile_version=v
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
  select jsonb_build_object('generation',s.generation,'jobs',coalesce((select jsonb_agg(job order by position) from page),'[]'),
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
revoke all on function public.read_account_matches(jsonb) from public,anon;
grant execute on function public.read_account_matches(jsonb) to authenticated;
