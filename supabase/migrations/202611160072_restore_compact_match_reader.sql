-- Keep the software scope on the shared reader so compact snapshots and
-- legacy scores use the same filtering before pagination and counts.
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
    where m.user_id=u and m.generation=s.generation
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
  ), scoped_scores as materialized (
    -- Apply software scope after reconstructing compact and legacy matches.
    select * from scored
    where job->'match'->>'softwareRole'='true'
      or (status<>'new' and coalesce(p_filters->>'view','jobs') in ('saved','all'))
  ), filtered as materialized (
    select * from scoped_scores
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
      score desc nulls last,coalesce((job->'match'->>'eligible')::boolean,false) desc,job_id) as position
    from deduplicated
  ), page as (select * from ordered order by position limit lim offset off)
  select jsonb_build_object('profileVersion',v,'generation',s.generation,'jobs',coalesce((select jsonb_agg(job order by position) from page),'[]'),
    'total',(select count(*) from deduplicated),'offset',off,'limit',lim,
    'counts',jsonb_build_object('toReview',(select count(*) from deduplicated where status='new'),
      'confirmed',(select count(*) from deduplicated where job->>'visaSignal'='confirmed' and not(coalesce(p_filters->'visaExempt','[]') ? country)),
      'fresh',(select count(*) from deduplicated where (job->>'postedDate')::timestamptz between now()-interval '3 days' and now()),
      'new',(select count(*) from scoped_scores where status='new' and within_window and active and country in(select country from public.account_countries where user_id=u)
        and coalesce((job->'match'->>'reviewable')::boolean,false)))) into result;
  return result || jsonb_build_object('catalog',s.summary->'catalog',
    'matching',jsonb_build_object('status',case when s.failed then 'failed' when s.token is not null and s.lease_until>now() then 'running'
      when s.profile_version=v then 'ready' else 'pending' end,
      'stale',s.profile_version is distinct from v or s.catalog_revision is distinct from r or s.computed_at is null or s.computed_at<now()-interval '6 hours',
      'profileCurrent',coalesce(s.profile_version=v and s.computed_at is not null,false),
      'computedAt',s.computed_at,'retryAt',s.retry_at));
end $$;

revoke all on function public.read_account_matches_for(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.read_account_matches_for(uuid,jsonb) to service_role;

create or replace function public.read_account_matches(p_filters jsonb default '{}') returns jsonb
language sql stable security definer set search_path='' as $$
  select public.read_account_matches_for(auth.uid(),p_filters);
$$;
revoke all on function public.read_account_matches(jsonb) from public,anon;
grant execute on function public.read_account_matches(jsonb) to authenticated;
