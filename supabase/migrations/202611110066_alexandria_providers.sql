-- Independent provider reservations share the existing global daily budget.
create table public.alexandria_provider_control (
 source text primary key references public.job_source_directory(id),
 reserved_credits integer not null check(reserved_credits between 1 and 100),
 retry_at timestamptz
);
insert into public.job_source_directory(id,kind,company,board,enabled)
select 'alexandria:'||provider,'alexandria',provider||' via Firecrawl Alexandria',provider,true
from unnest(array['theirstack','crustdata','blitzapi','builtin-com','smartrecruiters-com','ycombinator-com']) provider;
-- Use undiscounted documented maximums; free allowances are not assumed.
insert into public.alexandria_provider_control(source,reserved_credits) values
 ('alexandria:theirstack',100),('alexandria:crustdata',90),('alexandria:blitzapi',50),
 ('alexandria:builtin-com',30),('alexandria:smartrecruiters-com',30),('alexandria:ycombinator-com',5);
create table public.alexandria_provider_attempts (
 run_id uuid references public.job_search_runs(id) on delete cascade,
 source text references public.alexandria_provider_control(source),
 reserved_at timestamptz not null default now(),
 reserved_credits integer not null check(reserved_credits between 1 and 100),
 primary key(run_id,source)
);
alter table public.alexandria_provider_control enable row level security;
alter table public.alexandria_provider_attempts enable row level security;
revoke all on public.alexandria_provider_control,public.alexandria_provider_attempts from public,anon,authenticated;
grant all on public.alexandria_provider_control,public.alexandria_provider_attempts to service_role;
-- Expand the pilot default, retaining an explicitly changed operator limit.
update public.alexandria_search_control set daily_reserved_credits=600 where daily_reserved_credits=96;
create or replace function public.claim_alexandria_search(p_id uuid,p_token uuid) returns text
language plpgsql security invoker set search_path='' as $$
declare run public.job_search_runs; control public.alexandria_search_control; spent integer;
begin
 select * into run from public.job_search_runs where id=p_id for update;
 if not found or run.dispatch_token is distinct from p_token or run.status not in ('queued','running')
   or run.created_at<now()-interval '8 minutes' then raise exception 'Search lease lost'; end if;
 if not coalesce(run.sources @> '["alexandria:workable"]'::jsonb,false) then raise exception 'Source is outside the search plan'; end if;
 if run.results ? 'alexandria:workable' then return 'finished'; end if;
 if not exists(select 1 from public.job_source_directory where id='alexandria:workable' and enabled) then return 'disabled'; end if;
 select * into strict control from public.alexandria_search_control where singleton for update;
 if not control.enabled then return 'disabled'; end if;
 if control.retry_at>now() then return 'provider_backoff'; end if;
 if exists(select 1 from public.alexandria_search_attempts where run_id=p_id) then return 'already_attempted'; end if;
 select coalesce(sum(reserved_credits),0) into spent from public.alexandria_search_attempts
   where reserved_at>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC';
 select spent+coalesce(sum(reserved_credits),0) into spent from public.alexandria_provider_attempts where reserved_at>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC';
 if spent+8>control.daily_reserved_credits then return 'daily_budget'; end if;
 insert into public.alexandria_search_attempts(run_id) values(p_id);
 return 'claimed';
end $$;

create function public.claim_alexandria_provider(p_id uuid,p_token uuid,p_source text) returns text
language plpgsql security invoker set search_path='' as $$
declare run public.job_search_runs; control public.alexandria_search_control; spent integer; provider public.alexandria_provider_control;
begin
 select * into run from public.job_search_runs where id=p_id for update;
 if not found or run.dispatch_token is distinct from p_token or run.status not in ('queued','running')
   or run.created_at<now()-interval '8 minutes' then raise exception 'Search lease lost'; end if;
 if not coalesce(run.sources @> jsonb_build_array(p_source),false) then raise exception 'Source is outside the search plan'; end if;
 if run.results ? p_source then return 'finished'; end if;
 if not exists(select 1 from public.job_source_directory where id=p_source and enabled) then return 'disabled'; end if;
 select * into strict control from public.alexandria_search_control where singleton for update;
 if not control.enabled then return 'disabled'; end if;
 if control.retry_at>now() then return 'provider_backoff'; end if;
 select * into provider from public.alexandria_provider_control where source=p_source;
 if not found then raise exception 'Unknown Alexandria provider'; end if;
 if provider.retry_at>now() then return 'provider_backoff'; end if;
 if exists(select 1 from public.alexandria_provider_attempts where run_id=p_id and source=p_source) then return 'already_attempted'; end if;
 select coalesce(sum(reserved_credits),0) into spent from public.alexandria_search_attempts
   where reserved_at>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC';
 select spent+coalesce(sum(reserved_credits),0) into spent from public.alexandria_provider_attempts where reserved_at>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC';
 if spent+provider.reserved_credits>control.daily_reserved_credits then return 'daily_budget'; end if;
 insert into public.alexandria_provider_attempts(run_id,source,reserved_credits) values(p_id,p_source,provider.reserved_credits);
 return 'claimed';
end $$;

create function public.backoff_alexandria_provider(p_id uuid,p_token uuid,p_source text,p_seconds integer) returns void
language plpgsql security invoker set search_path='' as $$
begin
 if not exists(select 1 from public.job_search_runs where id=p_id and dispatch_token=p_token and status in ('queued','running') and sources @> jsonb_build_array(p_source)) then raise exception 'Search lease lost'; end if;
 if p_seconds not between 60 and 86400 then raise exception 'Invalid backoff'; end if;
 update public.alexandria_provider_control set retry_at=greatest(coalesce(retry_at,now()),now()+make_interval(secs=>p_seconds)) where source=p_source;
end $$;
create function public.publish_alexandria_provider(p_id uuid,p_token uuid,p_source text,p_jobs jsonb,p_requests integer,p_metrics jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare selected jsonb; receipt jsonb;
begin
 perform 1 from public.job_search_runs where id=p_id for update;
 if not exists(select 1 from public.alexandria_provider_attempts where run_id=p_id and source=p_source) then raise exception 'Paid search was not reserved'; end if;
 if jsonb_typeof(p_jobs) is distinct from 'array' or jsonb_array_length(p_jobs)>20 or octet_length(p_jobs::text)>1048576 then raise exception 'Invalid Alexandria observations'; end if;
 -- Serialize against the normal observation publisher before duplicate checks.
 perform pg_catalog.pg_advisory_xact_lock(730103006);
 select coalesce(jsonb_agg(x),'[]') into selected from jsonb_array_elements(p_jobs) x
 where not exists(select 1 from public.job_catalog j where j.id<>x->>'id' and j.country=x->>'country' and
   (regexp_replace(j.url,'[?#].*$','')=regexp_replace(x->>'url','[?#].*$','') or
    (lower(regexp_replace(j.company,'[^[:alnum:]]+',' ','g'))=lower(regexp_replace(x->>'company','[^[:alnum:]]+',' ','g')) and
     lower(regexp_replace(j.title,'[^[:alnum:]]+',' ','g'))=lower(regexp_replace(x->>'title','[^[:alnum:]]+',' ','g')))));
 receipt := public.publish_job_search_source(p_id,p_token,p_source,selected,false,null,p_requests);
 if jsonb_typeof(p_metrics) is distinct from 'object' or octet_length(p_metrics::text)>4096 then raise exception 'Invalid metrics'; end if;
 receipt := receipt || jsonb_build_object('observation',p_metrics);
 update public.job_search_runs set results=jsonb_set(results,array[p_source],receipt) where id=p_id and dispatch_token=p_token;
 return receipt;
end $$;
revoke all on function public.claim_alexandria_provider(uuid,uuid,text),public.backoff_alexandria_provider(uuid,uuid,text,integer),public.publish_alexandria_provider(uuid,uuid,text,jsonb,integer,jsonb) from public,anon,authenticated;
grant execute on function public.claim_alexandria_provider(uuid,uuid,text),public.backoff_alexandria_provider(uuid,uuid,text,integer),public.publish_alexandria_provider(uuid,uuid,text,jsonb,integer,jsonb) to service_role;
create or replace function public.guard_alexandria_inventory() returns trigger language plpgsql set search_path='' as $$
begin
 if coalesce(to_jsonb(new)->>'source_id',to_jsonb(new)->>'source')like 'alexandria:%' then raise exception 'Alexandria requires a scoped job search'; end if;
 return new;
end $$;
