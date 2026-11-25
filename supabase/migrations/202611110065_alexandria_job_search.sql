-- Paid cross-employer searches are scoped observations, never full ATS inventories.
alter table public.job_source_directory drop constraint job_source_directory_kind_check;
alter table public.job_source_directory add constraint job_source_directory_kind_check check(kind in ('ashby','greenhouse','lever','arbeitnow','smartrecruiters','workday','linkedin','recruitee','workable','alexandria'));
insert into public.job_source_directory(id,kind,company,board,enabled)
values('alexandria:workable','alexandria','Workable via Firecrawl Alexandria','workable',true);

create table public.alexandria_search_control (
 singleton boolean primary key default true check(singleton),
 enabled boolean not null default true,
 daily_reserved_credits integer not null default 96 check(daily_reserved_credits between 0 and 960),
 retry_at timestamptz
);
insert into public.alexandria_search_control(singleton) values(true);
create table public.alexandria_search_attempts (
 run_id uuid primary key references public.job_search_runs(id) on delete cascade,
 reserved_at timestamptz not null default now(),
 reserved_credits integer not null default 8 check(reserved_credits=8)
);
alter table public.alexandria_search_control enable row level security;
alter table public.alexandria_search_attempts enable row level security;
revoke all on public.alexandria_search_control,public.alexandria_search_attempts from public,anon,authenticated;
grant all on public.alexandria_search_control,public.alexandria_search_attempts to service_role;

-- Reserve before any paid request. Ambiguous/crashed attempts are never rebought.
create function public.claim_alexandria_search(p_id uuid,p_token uuid) returns text
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
 if spent+8>control.daily_reserved_credits then return 'daily_budget'; end if;
 insert into public.alexandria_search_attempts(run_id) values(p_id);
 return 'claimed';
end $$;

create function public.backoff_alexandria_search(p_id uuid,p_token uuid,p_seconds integer) returns void
language plpgsql security invoker set search_path='' as $$
begin
 if not exists(select 1 from public.job_search_runs where id=p_id and dispatch_token=p_token and status in ('queued','running')) then raise exception 'Search lease lost'; end if;
 if p_seconds not between 60 and 86400 then raise exception 'Invalid backoff'; end if;
 update public.alexandria_search_control set retry_at=greatest(coalesce(retry_at,now()),now()+make_interval(secs=>p_seconds)) where singleton;
end $$;

create function public.publish_alexandria_search(p_id uuid,p_token uuid,p_jobs jsonb,p_requests integer) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare selected jsonb;
begin
 perform 1 from public.job_search_runs where id=p_id for update;
 if not exists(select 1 from public.alexandria_search_attempts where run_id=p_id) then raise exception 'Paid search was not reserved'; end if;
 if jsonb_typeof(p_jobs) is distinct from 'array' or jsonb_array_length(p_jobs)>20 or octet_length(p_jobs::text)>1048576 then raise exception 'Invalid Alexandria observations'; end if;
 -- Serialize against the normal observation publisher before duplicate checks.
 perform pg_catalog.pg_advisory_xact_lock(730103006);
 select coalesce(jsonb_agg(x),'[]') into selected from jsonb_array_elements(p_jobs) x
 where not exists(select 1 from public.job_catalog j where j.id<>x->>'id' and j.country=x->>'country' and
   (regexp_replace(j.url,'[?#].*$','')=regexp_replace(x->>'url','[?#].*$','') or
    (lower(regexp_replace(j.company,'[^[:alnum:]]+',' ','g'))=lower(regexp_replace(x->>'company','[^[:alnum:]]+',' ','g')) and
     lower(regexp_replace(j.title,'[^[:alnum:]]+',' ','g'))=lower(regexp_replace(x->>'title','[^[:alnum:]]+',' ','g')))));
 return public.publish_job_search_source(p_id,p_token,'alexandria:workable',selected,false,null,p_requests);
end $$;
revoke all on function public.claim_alexandria_search(uuid,uuid),public.backoff_alexandria_search(uuid,uuid,integer),public.publish_alexandria_search(uuid,uuid,jsonb,integer) from public,anon,authenticated;
grant execute on function public.claim_alexandria_search(uuid,uuid),public.backoff_alexandria_search(uuid,uuid,integer),public.publish_alexandria_search(uuid,uuid,jsonb,integer) to service_role;

-- Prevent accidental full-inventory collection from retiring search observations.
create function public.guard_alexandria_inventory() returns trigger language plpgsql set search_path='' as $$
begin
 if coalesce(to_jsonb(new)->>'source_id',to_jsonb(new)->>'source')='alexandria:workable' then raise exception 'Alexandria requires a scoped job search'; end if;
 return new;
end $$;
create trigger guard_alexandria_inventory before insert on public.job_catalog_runs
for each row execute function public.guard_alexandria_inventory();
-- The source-task ledger is optional on older staging installations.
do $$ begin
 if to_regclass('public.catalog_source_tasks') is not null then
  execute 'create trigger guard_alexandria_inventory before insert on public.catalog_source_tasks for each row execute function public.guard_alexandria_inventory()';
 end if;
end $$;
