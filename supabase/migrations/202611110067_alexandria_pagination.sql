-- Shared pacing and durable, scope-specific continuation for paid discovery.
alter table public.alexandria_search_control drop constraint alexandria_search_control_daily_reserved_credits_check;
alter table public.alexandria_search_control add check(daily_reserved_credits between 0 and 10000);
update public.alexandria_search_control set daily_reserved_credits=2000 where daily_reserved_credits=600;
alter table public.alexandria_search_control add column next_request_at timestamptz;
alter table public.alexandria_provider_control drop constraint alexandria_provider_control_reserved_credits_check;
alter table public.alexandria_provider_control add check(reserved_credits between 1 and 1000);
alter table public.alexandria_provider_attempts drop constraint alexandria_provider_attempts_reserved_credits_check;
alter table public.alexandria_provider_attempts add check(reserved_credits between 1 and 1000);
-- Three bounded pages/segments, at undiscounted prices (429s are rejected requests).
update public.alexandria_provider_control set reserved_credits=reserved_credits*3;
create table public.alexandria_search_cursors (
 scope text not null,
 source text not null references public.alexandria_provider_control(source),
 position jsonb not null default '{}' check(jsonb_typeof(position)='object' and octet_length(position::text)<=131072),
 owner uuid references public.job_search_runs(id) on delete set null,
 updated_at timestamptz not null default now(),
 primary key(scope,source)
);
alter table public.alexandria_search_cursors enable row level security;
revoke all on public.alexandria_search_cursors from public,anon,authenticated;
grant all on public.alexandria_search_cursors to service_role;
create function public.alexandria_cursor_scope(p_run public.job_search_runs) returns text
language sql stable set search_path='' as $$
 select md5(to_jsonb(p_run.roles)::text||to_jsonb(p_run.countries)::text||to_char(p_run.created_at at time zone 'UTC','YYYY-MM-DD'))
$$;
-- Scope ownership fences concurrent cursor consumers, independently of dispatch replay.
do $$ declare definition text; begin
 definition:=pg_get_functiondef('public.claim_alexandria_provider(uuid,uuid,text)'::regprocedure);
 definition:=replace(definition,'insert into public.alexandria_provider_attempts(run_id,source,reserved_credits)',
 $patch$insert into public.alexandria_search_cursors(scope,source) values(public.alexandria_cursor_scope(run),p_source) on conflict do nothing;
 perform 1 from public.alexandria_search_cursors where scope=public.alexandria_cursor_scope(run) and source=p_source for update;
 if exists(select 1 from public.alexandria_search_cursors c join public.job_search_runs r on r.id=c.owner where c.scope=public.alexandria_cursor_scope(run) and c.source=p_source and c.owner<>p_id and r.status in ('queued','running') and r.created_at>now()-interval '8 minutes') then return 'scope_busy'; end if;
 if exists(select 1 from public.alexandria_search_cursors where scope=public.alexandria_cursor_scope(run) and source=p_source and position->>'exhausted'='true') then return 'exhausted'; end if;
 update public.alexandria_search_cursors set owner=p_id where scope=public.alexandria_cursor_scope(run) and source=p_source;
 insert into public.alexandria_provider_attempts(run_id,source,reserved_credits)$patch$);
 execute definition;
 definition:=pg_get_functiondef('public.publish_job_search_source(uuid,uuid,text,jsonb,boolean,integer,integer)'::regprocedure);
 definition:=replace(definition,'p_requests not between 1 and 100','(p_requests not between 1 and 100 and not (p_requests=0 and p_source like ''alexandria:%''))');
 definition:=replace(definition,'p_requests not between 1 and 60','(p_requests not between 1 and 60 and not (p_requests=0 and p_source like ''alexandria:%''))');
 definition:=replace(definition,'p_requests not between 1 and 9','((p_requests not between 1 and 9 and p_source not like ''alexandria:%'') or (p_source like ''alexandria:%'' and p_requests not between 0 and 60))');
 execute definition;
 definition:=pg_get_functiondef('public.publish_alexandria_provider(uuid,uuid,text,jsonb,integer,jsonb)'::regprocedure);
 definition:=replace(definition,'octet_length(p_metrics::text)>4096','octet_length(p_metrics::text)>131072');
 definition:=replace(definition,'''observation'',p_metrics','''observation'',p_metrics #- ''{continuation,pending}''');
 definition:=replace(definition,'jsonb_array_length(p_jobs)>20','jsonb_array_length(p_jobs)>100');
 definition:=replace(definition,'declare selected jsonb; receipt jsonb;','declare selected jsonb; receipt jsonb; run public.job_search_runs;');
 definition:=replace(definition,'perform 1 from public.job_search_runs where id=p_id for update;',
 $patch$select * into run from public.job_search_runs where id=p_id for update;
 if run.dispatch_token is distinct from p_token then raise exception 'Search lease lost'; end if;
 if run.results ? p_source then return run.results->p_source; end if;$patch$);
 definition:=replace(definition,'return receipt;',
 $patch$update public.alexandria_search_cursors set position=coalesce(p_metrics->'continuation','{}'),updated_at=now() where scope=public.alexandria_cursor_scope(run) and source=p_source and owner=p_id;
 if not found then raise exception 'Cursor ownership lost'; end if;
 return receipt;$patch$);
 execute definition;
end $$;
create function public.read_alexandria_cursor(p_id uuid,p_token uuid,p_source text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare run public.job_search_runs; result jsonb;
begin
 select * into run from public.job_search_runs where id=p_id and dispatch_token=p_token;
 if not found then raise exception 'Search lease lost'; end if;
 select position into strict result from public.alexandria_search_cursors where scope=public.alexandria_cursor_scope(run) and source=p_source and owner=p_id;
 return result;
end $$;
-- Acquire only when ready to send. Waiting workers do not hold DB locks or book stale slots.
create function public.alexandria_request_slot(p_id uuid,p_token uuid,p_delay_ms integer default 0) returns integer
language plpgsql security invoker set search_path='' as $$
declare next_at timestamptz;
begin
 if not exists(select 1 from public.job_search_runs where id=p_id and dispatch_token=p_token and status in ('queued','running') and created_at>now()-interval '8 minutes') then raise exception 'Search lease lost'; end if;
 if not exists(select 1 from public.alexandria_provider_attempts where run_id=p_id) and not exists(select 1 from public.alexandria_search_attempts where run_id=p_id) then raise exception 'Paid search was not reserved'; end if;
 if p_delay_ms not between 0 and 86400000 then raise exception 'Invalid rate delay'; end if;
 select next_request_at into next_at from public.alexandria_search_control where singleton for update;
 if p_delay_ms>0 then
  update public.alexandria_search_control set next_request_at=greatest(coalesce(next_request_at,now()),now()+p_delay_ms*interval '1 millisecond') where singleton;
  return p_delay_ms;
 end if;
 if next_at>clock_timestamp() then return ceil(extract(epoch from (next_at-clock_timestamp()))*1000)::integer; end if;
 update public.alexandria_search_control set next_request_at=clock_timestamp()+interval '7 seconds' where singleton;
 return 0;
end $$;
revoke all on function public.alexandria_cursor_scope(public.job_search_runs),public.read_alexandria_cursor(uuid,uuid,text),public.alexandria_request_slot(uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.alexandria_cursor_scope(public.job_search_runs),public.read_alexandria_cursor(uuid,uuid,text),public.alexandria_request_slot(uuid,uuid,integer) to service_role;

-- Retire the pilot's artificial one-hour 429 backoff only when its receipt proves
-- rate limiting. Explicit long/payment/operator backoffs remain in force.
update public.alexandria_provider_control c set retry_at=least(c.retry_at,now()+interval '1 minute')
where c.retry_at>now() and c.retry_at<=now()+interval '1 hour'
 and exists(select 1 from public.job_search_runs r where r.created_at>now()-interval '1 hour' and r.results->c.source->'observation'->>'failure'='rate_limit');
