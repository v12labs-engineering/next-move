-- Public, derived listing features only. Resumes and account evidence never enter this table.
-- Title vectors are shared between listings; vectors use binary real[] storage, not decimal JSON.
create table public.catalog_matching_titles (
  title_hash text primary key check(title_hash ~ '^[a-f0-9]{64}$'),
  engine_version text not null,
  embedding real[] not null check(cardinality(embedding)=1024)
);
alter table public.catalog_matching_titles enable row level security;
revoke all on public.catalog_matching_titles from public,anon,authenticated;
grant select,insert,update,delete on public.catalog_matching_titles to service_role;

create table public.catalog_matching_features (
  job_id text primary key references public.job_catalog(id) on delete cascade,
  source_hash text not null check (source_hash ~ '^[a-f0-9]{64}$'),
  engine_version text not null,
  search_text text not null,
  search_vector tsvector generated always as (to_tsvector('simple',search_text)) stored,
  features jsonb not null,
  embedding real[] not null check(cardinality(embedding)=384),
  title_hash text not null references public.catalog_matching_titles(title_hash),
  updated_at timestamptz not null default now()
);
alter table public.catalog_matching_features enable row level security;
revoke all on public.catalog_matching_features from public,anon,authenticated;
grant select,insert,update,delete on public.catalog_matching_features to service_role;

create table public.matching_engine_policy (
  singleton boolean primary key default true check(singleton),
  version text not null
);
insert into public.matching_engine_policy values(true,'legacy-v1');
alter table public.matching_engine_policy enable row level security;
revoke all on public.matching_engine_policy from public,anon,authenticated;
grant select,update on public.matching_engine_policy to service_role;

create function public.activate_matching_engine(p_version text) returns void
language plpgsql security invoker set search_path='' as $$
declare previous text;
begin
  if p_version !~ '^(legacy-v1|oss-[a-z0-9-]{1,80})$' then raise exception 'Invalid matching policy'; end if;
  select version into strict previous from public.matching_engine_policy where singleton for update;
  if previous=p_version then return; end if;
  update public.matching_engine_policy set version=p_version where singleton;
  -- Preserve published generations, but fence every worker using the old policy.
  update public.account_match_state set token=null,building_version=null,lease_until=null,
    computed_at=null,failed=false,retry_at=null;
end $$;
revoke all on function public.activate_matching_engine(text) from public,anon,authenticated;
grant execute on function public.activate_matching_engine(text) to service_role;

create function public.cache_matching_features(p_rows jsonb) returns void
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
revoke all on function public.cache_matching_features(jsonb) from public,anon,authenticated;
grant execute on function public.cache_matching_features(jsonb) to service_role;

-- Text retrieval scores are combined with MiniLM semantic ranks in the worker using RRF.
-- This bounded read never receives or stores candidate resumes or evidence.
create function public.read_matching_features(p_ids text[],p_query text,p_version text)
returns table(job_id text,source_hash text,features jsonb,lexical_score real)
language sql stable security invoker set search_path='' as $$
  select f.job_id,f.source_hash,f.features || jsonb_build_object('embedding',f.embedding,'titleEmbedding',t.embedding),
    ts_rank_cd(f.search_vector,websearch_to_tsquery('simple',left(p_query,4000)))
  from public.catalog_matching_features f
  join public.catalog_matching_titles t on t.title_hash=f.title_hash and t.engine_version=f.engine_version
  where f.job_id=any(p_ids) and f.engine_version=p_version and cardinality(p_ids)<=20;
$$;
revoke all on function public.read_matching_features(text[],text,text) from public,anon,authenticated;
grant execute on function public.read_matching_features(text[],text,text) to service_role;

-- Preserve posting windows and account filtering; add policy metadata and retrieval tie-break.
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
  select revision into r from public.catalog_match_revision;
  with owned_scores as materialized (
    select m.job,m.score,m.job_id,m.country from public.account_match_jobs m
    where m.user_id=u and m.generation=s.generation and s.profile_version=v
  ), scored as materialized (
    select m.job || jsonb_build_object('status',coalesce(a.status,'new'),'isActive',coalesce(c.is_active,false),
      'lastCheckedAt',coalesce(c.last_checked_at,(m.job->>'lastCheckedAt')::timestamptz)) as job,
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
      'stale',s.profile_version is distinct from v or s.catalog_revision is distinct from r or s.computed_at is null or s.computed_at<now()-interval '15 minutes',
      'computedAt',s.computed_at,'retryAt',s.retry_at,'engineVersion',coalesce(s.summary->>'engineVersion','legacy-v1')));
end $$;
revoke all on function public.read_account_matches(jsonb) from public,anon;
grant execute on function public.read_account_matches(jsonb) to authenticated;
