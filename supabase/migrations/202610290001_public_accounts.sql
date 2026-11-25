-- Additive migration: preserve private legacy data, never assign it to signups.
create table public.job_catalog (
  id text primary key,
  title text not null,
  company text not null,
  country text not null,
  city text,
  url text not null check (url ~ '^https?://'),
  description text not null default '',
  work_mode text not null default 'unknown' check (work_mode in ('remote','hybrid','onsite','unknown')),
  visa_signal public.visa_confidence not null default 'weak',
  sponsorship_evidence text not null default '',
  sponsor_verified boolean not null default false,
  source text not null,
  posted_at timestamptz,
  discovered_at timestamptz not null default now()
);
insert into public.job_catalog(id,title,company,country,city,url,work_mode,visa_signal,source,discovered_at)
select j.id,j.title,coalesce(c.name,'Unknown company'),j.country,j.city,j.source_url,
  case when j.work_mode in ('remote','hybrid','onsite') then j.work_mode else 'unknown' end,
  'possible'::public.visa_confidence,j.source_type,coalesce(j.created_at,now())
from public.jobs j left join public.companies c on c.id=j.company_id
where j.source_url ~ '^https?://';

create table public.account_profiles (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  data jsonb not null check (jsonb_typeof(data)='object' and octet_length(data::text) <= 80000),
  version integer not null default 1,
  updated_at timestamptz not null default now()
);
create index job_catalog_country_discovered_idx on public.job_catalog(country,discovered_at desc);
create table public.account_countries (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  country text not null check (country in ('Australia','Germany','Netherlands','Ireland','Sweden','Denmark','Japan','UAE')),
  added_at timestamptz not null default now(),
  primary key(user_id,country)
);
create table public.account_job_states (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  job_id text not null references public.job_catalog(id) on delete cascade,
  status text not null check (status in ('new','interested','applied','dismissed')),
  updated_at timestamptz not null default now(),
  primary key(user_id,job_id)
);
create table public.resume_drafts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  job_id text not null references public.job_catalog(id),
  profile_version integer not null,
  content text not null check (length(content) between 1 and 50000),
  evidence jsonb not null,
  model text not null,
  created_at timestamptz not null default now()
);
create index account_job_states_user_updated_idx on public.account_job_states(user_id,updated_at desc);
create index resume_drafts_user_created_idx on public.resume_drafts(user_id,created_at desc);
create table public.account_ai_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  attempts integer not null check (attempts between 1 and 10),
  primary key(user_id,day)
);

alter table public.job_catalog enable row level security;
alter table public.account_profiles enable row level security;
alter table public.account_countries enable row level security;
alter table public.account_job_states enable row level security;
alter table public.resume_drafts enable row level security;
alter table public.account_ai_usage enable row level security;
revoke all on public.job_catalog,public.account_profiles,public.account_countries,public.account_job_states,public.resume_drafts,public.account_ai_usage from anon,authenticated;
grant select on public.job_catalog to authenticated;
grant select,insert,update on public.account_profiles to authenticated;
grant select,insert,update,delete on public.account_countries,public.account_job_states to authenticated;
grant select,insert,delete on public.resume_drafts to authenticated;
grant update(content) on public.resume_drafts to authenticated;
grant select on public.account_ai_usage to authenticated;
grant all on public.job_catalog,public.account_profiles,public.account_countries,public.account_job_states,public.resume_drafts,public.account_ai_usage to service_role;
create policy catalog_read on public.job_catalog for select to authenticated using (true);
create policy profile_owner on public.account_profiles for all to authenticated using ((select auth.uid())=user_id) with check ((select auth.uid())=user_id);
create policy country_owner on public.account_countries for all to authenticated using ((select auth.uid())=user_id) with check ((select auth.uid())=user_id);
create policy state_owner on public.account_job_states for all to authenticated using ((select auth.uid())=user_id) with check ((select auth.uid())=user_id);
create policy draft_owner on public.resume_drafts for all to authenticated using ((select auth.uid())=user_id) with check ((select auth.uid())=user_id);
create policy usage_owner on public.account_ai_usage for select to authenticated using ((select auth.uid())=user_id);

-- Transactional onboarding/profile edit. Ownership is derived from the session.
create function public.save_candidate(p_data jsonb, p_version integer) returns void language plpgsql security invoker set search_path='' as $$
declare v_country text; v_version integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if jsonb_typeof(p_data->'targetCountries') is distinct from 'array' or jsonb_array_length(p_data->'targetCountries') not between 1 and 8 then
    raise exception 'Choose target countries';
  end if;
  insert into public.account_profiles(user_id,data) values(auth.uid(),p_data - 'targetCountries')
    on conflict(user_id) do update set data=excluded.data,version=public.account_profiles.version+1,updated_at=now()
      where public.account_profiles.version=p_version
    returning version into v_version;
  if v_version is null then raise exception 'Profile changed in another session' using errcode='40001'; end if;
  delete from public.account_countries where user_id=auth.uid();
  for v_country in select jsonb_array_elements_text(p_data->'targetCountries') loop
    insert into public.account_countries(user_id,country) values(auth.uid(),v_country) on conflict do nothing;
  end loop;
end $$;
revoke all on function public.save_candidate(jsonb,integer) from public,anon;
grant execute on function public.save_candidate(jsonb,integer) to authenticated;

-- Atomic daily attempt quota; failures count too, to bound provider abuse.
create function public.reserve_tailoring_attempt() returns boolean language plpgsql security definer set search_path='' as $$
declare v_count integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  insert into public.account_ai_usage(user_id,day,attempts) values(auth.uid(),(now() at time zone 'UTC')::date,1)
    on conflict(user_id,day) do update set attempts=public.account_ai_usage.attempts+1
    where public.account_ai_usage.attempts<10 returning attempts into v_count;
  return v_count is not null;
end $$;
revoke all on function public.reserve_tailoring_attempt() from public,anon;
grant execute on function public.reserve_tailoring_attempt() to authenticated;

-- The old policies trusted any authenticated user. Remove public access to all
-- legacy private tables, while retaining service-role ingestion access.
do $$ declare t text; begin
  foreach t in array array['candidate_profiles','country_scores','companies','jobs','people','drafts','applications','source_connectors','prompt_templates','app_state','tracked_countries','collection_runs','simple_state','research_crawl_runs','research_documents','research_chunks','research_reports','ai_search_runs','ai_lane_overrides'] loop
    if to_regclass('public.'||t) is not null then
      execute format('revoke all on table public.%I from public,anon,authenticated',t);
    end if;
  end loop;
end $$;
