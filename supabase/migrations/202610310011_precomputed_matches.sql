-- Scores are server-produced. A generation is visible only after complete publication.
create table public.catalog_match_revision (
  id boolean primary key default true check(id), revision bigint not null default 1
);
insert into public.catalog_match_revision default values;
create function public.bump_catalog_match_revision() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  update public.catalog_match_revision set revision=revision+1;
  return null;
end $$;
create trigger catalog_match_revision after insert or update or delete on public.job_catalog
for each statement execute function public.bump_catalog_match_revision();

create table public.account_match_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  generation uuid,
  profile_version integer,
  catalog_revision bigint,
  computed_at timestamptz,
  summary jsonb,
  token uuid,
  building_version integer,
  building_revision bigint,
  lease_until timestamptz,
  retry_at timestamptz,
  failed boolean not null default false
);
create table public.account_match_jobs (
  user_id uuid not null references auth.users(id) on delete cascade,
  generation uuid not null,
  job_id text not null references public.job_catalog(id) on delete cascade,
  job jsonb not null check(not (job ? 'description')),
  score integer generated always as ((job->'match'->>'score')::integer) stored,
  country text generated always as (job->>'country') stored,
  primary key(user_id,generation,job_id)
);
create index account_match_rank_idx on public.account_match_jobs(user_id,generation,score desc,job_id);
create index account_match_country_rank_idx on public.account_match_jobs(user_id,generation,country,score desc,job_id);

alter table public.catalog_match_revision enable row level security;
alter table public.account_match_state enable row level security;
alter table public.account_match_jobs enable row level security;
revoke all on public.catalog_match_revision,public.account_match_state,public.account_match_jobs from public,anon,authenticated;
grant all on public.catalog_match_revision,public.account_match_state,public.account_match_jobs to service_role;
grant select on public.account_match_state,public.account_match_jobs to authenticated;
create policy match_state_owner on public.account_match_state for select to authenticated using(user_id=(select auth.uid()));
create policy match_job_owner on public.account_match_jobs for select to authenticated using(user_id=(select auth.uid()));

create function public.claim_account_matching(p_user uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.account_match_state; v integer; r bigint;
begin
  -- Lock the profile first in all writer functions to serialize with profile saves.
  select version into v from public.account_profiles where user_id=p_user for share;
  if v is null then return null; end if;
  select revision into r from public.catalog_match_revision;
  insert into public.account_match_state(user_id) values(p_user) on conflict do nothing;
  select * into s from public.account_match_state where user_id=p_user for update;
  if s.token is not null and s.building_version=v and s.lease_until>now() then return null; end if;
  if s.profile_version=v and s.catalog_revision=r and s.computed_at>now()-interval '15 minutes' then return null; end if;
  if s.retry_at>now() and s.building_version=v then return null; end if;
  delete from public.account_match_jobs where user_id=p_user and generation is distinct from s.generation;
  update public.account_match_state set token=gen_random_uuid(),building_version=v,building_revision=r,
    lease_until=now()+interval '10 minutes',retry_at=null,failed=false where user_id=p_user returning * into s;
  return jsonb_build_object('token',s.token,'profileVersion',v,'catalogRevision',r);
end $$;

create function public.stage_account_matches(p_user uuid,p_token uuid,p_jobs jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare s public.account_match_state;
begin
  select * into s from public.account_match_state where user_id=p_user for update;
  if s.token is distinct from p_token or s.lease_until<=now() then raise exception 'Matching run superseded'; end if;
  if jsonb_array_length(p_jobs)>200 then raise exception 'Matching batch too large'; end if;
  insert into public.account_match_jobs(user_id,generation,job_id,job)
    select p_user,p_token,j->>'id',j-'description' from jsonb_array_elements(p_jobs) j
    on conflict(user_id,generation,job_id) do update set job=excluded.job;
  update public.account_match_state set lease_until=now()+interval '10 minutes' where user_id=p_user;
end $$;

create function public.reset_account_matches(p_user uuid,p_token uuid) returns void
language plpgsql security definer set search_path='' as $$
declare s public.account_match_state;
begin
  select * into s from public.account_match_state where user_id=p_user for update;
  if s.token is distinct from p_token or s.lease_until<=now() then raise exception 'Matching run superseded'; end if;
  -- A retry recomputes the complete set; don't retain rows from an earlier attempt.
  delete from public.account_match_jobs where user_id=p_user and generation=p_token;
  update public.account_match_state set lease_until=now()+interval '10 minutes' where user_id=p_user;
end $$;

create function public.publish_account_matches(p_user uuid,p_token uuid,p_summary jsonb,p_count integer) returns boolean
language plpgsql security definer set search_path='' as $$
declare s public.account_match_state; v integer;
begin
  select version into v from public.account_profiles where user_id=p_user for share;
  select * into s from public.account_match_state where user_id=p_user for update;
  if s.generation=p_token then return true; end if;
  if s.token is distinct from p_token or s.lease_until<=now() then return false; end if;
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

create function public.fail_account_matching(p_user uuid,p_token uuid) returns void
language sql security definer set search_path='' as $$
  update public.account_match_state set token=null,lease_until=null,failed=true,retry_at=now()+interval '1 minute'
    where user_id=p_user and token=p_token;
$$;

-- Only the operator can create or publish scores; clients can only read their own.
revoke all on function public.bump_catalog_match_revision() from public,anon,authenticated;
revoke all on function public.claim_account_matching(uuid),public.stage_account_matches(uuid,uuid,jsonb),public.reset_account_matches(uuid,uuid),
  public.publish_account_matches(uuid,uuid,jsonb,integer),public.fail_account_matching(uuid,uuid) from public,anon,authenticated;
grant execute on function public.claim_account_matching(uuid),public.stage_account_matches(uuid,uuid,jsonb),public.reset_account_matches(uuid,uuid),
  public.publish_account_matches(uuid,uuid,jsonb,integer),public.fail_account_matching(uuid,uuid) to service_role;

-- One bounded response, with counts across the filtered match set, independent of catalogue volume.
create function public.read_account_matches(p_filters jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare u uuid:=auth.uid(); s public.account_match_state; v integer; r bigint; result jsonb;
  lim integer:=least(200,greatest(1,coalesce((p_filters->>'limit')::integer,25)));
  off integer:=greatest(0,coalesce((p_filters->>'offset')::integer,0));
begin
  if u is null then raise exception 'Authentication required'; end if;
  select version into v from public.account_profiles where user_id=u;
  if v is null then raise exception 'Complete your profile first'; end if;
  select * into s from public.account_match_state where user_id=u;
  if p_filters->>'generation' is not null and (p_filters->>'generation')::uuid is distinct from s.generation then off:=0; end if;
  select revision into r from public.catalog_match_revision;
  with scored as materialized (
    select m.job || jsonb_build_object('status',coalesce(a.status,'new'),'isActive',c.is_active,
      'lastCheckedAt',c.last_checked_at) as job,
      m.score,m.job_id,m.country,coalesce(a.status,'new') as status,
      min((m.job->>'seenAt')::timestamptz) over(partition by m.job->>'url') as first_seen,
      c.is_active and c.last_checked_at>=now()-interval '7 days' as active
    from public.account_match_jobs m
    join public.job_catalog c on c.id=m.job_id
    left join public.account_job_states a on a.user_id=u and a.job_id=m.job_id
    where m.user_id=u and m.generation=s.generation and s.profile_version=v
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
      case when p_filters->>'sort'='newest' then (job->>'seenAt')::timestamptz end desc nulls last,
      coalesce((job->'match'->>'eligible')::boolean,false) desc,score desc,job_id) as position
    from deduplicated
  ), page as (select * from ordered order by position limit lim offset off)
  select jsonb_build_object('generation',s.generation,'jobs',coalesce((select jsonb_agg(job order by position) from page),'[]'),
    'total',(select count(*) from deduplicated),'offset',off,'limit',lim,
    'counts',jsonb_build_object('toReview',(select count(*) from deduplicated where status='new'),
      'confirmed',(select count(*) from deduplicated where job->>'visaSignal'='confirmed' and not(coalesce(p_filters->'visaExempt','[]') ? country)),
      'fresh',(select count(*) from deduplicated where (job->>'postedDate')::timestamptz>=now()-interval '3 days'),
      'new',(select count(*) from scored where status='new' and active and country in(select country from public.account_countries where user_id=u)
        and coalesce((job->'match'->>'reviewable')::boolean,false)))) into result;
  return result || jsonb_build_object('catalog',case when s.profile_version=v then s.summary->'catalog' else null end,
    'matching',jsonb_build_object('status',case when s.failed then 'failed' when s.token is not null and s.lease_until>now() then 'running'
      when s.profile_version=v then 'ready' else 'pending' end,
      'stale',s.profile_version is distinct from v or s.catalog_revision is distinct from r or s.computed_at is null or s.computed_at<now()-interval '15 minutes',
      'computedAt',s.computed_at,'retryAt',s.retry_at));
end $$;
revoke all on function public.read_account_matches(jsonb) from public,anon;
grant execute on function public.read_account_matches(jsonb) to authenticated;
