-- Bounded, service-only archive intake. Archived URLs never activate sources.
create table public.archive_discovery_channels (
 partition text primary key check(partition in ('ashby','greenhouse','greenhouse-legacy','lever','smartrecruiters','smartrecruiters-careers','workday','recruitee','workable')),
 pinned_index text check(pinned_index ~ '^CC-MAIN-20[0-9]{2}-[0-9]{2}$'),
 next_page integer not null default 0 check(next_page between 0 and 1000000),
 completed_index text,
 last_attempt_at timestamptz,
 next_attempt_at timestamptz not null default now(),
 failures integer not null default 0
);
insert into public.archive_discovery_channels(partition) select unnest(array['ashby','greenhouse','greenhouse-legacy','lever','smartrecruiters','smartrecruiters-careers','workday','recruitee','workable']);
create table public.archive_discovery_runs (
 id uuid primary key default gen_random_uuid(),
 request_key text not null unique check(length(request_key) between 1 and 180),
 token uuid not null default gen_random_uuid(),
 partition text not null references public.archive_discovery_channels(partition),
 pinned_index text, page integer not null,
 status text not null default 'running' check(status in ('running','completed','unchanged','failed','interrupted')),
 started_at timestamptz not null default now(), finished_at timestamptz,
 result jsonb
);
create index archive_discovery_runs_started on public.archive_discovery_runs(started_at);
create table public.archive_discovery_control (
 singleton boolean primary key default true check(singleton),
 current_run uuid references public.archive_discovery_runs(id),
 lease_until timestamptz, provider_retry_at timestamptz,
 daily_page_limit integer not null default 12 check(daily_page_limit between 0 and 12)
);
insert into public.archive_discovery_control default values;
do $$ declare t text; begin
 foreach t in array array['archive_discovery_channels','archive_discovery_runs','archive_discovery_control'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant all on public.%I to service_role',t);
 end loop;
end $$;

create function public.claim_archive_discovery(p_request_key text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare c public.archive_discovery_control; r public.archive_discovery_runs; channel public.archive_discovery_channels;
begin
 if p_request_key is null or length(p_request_key) not between 1 and 180 then raise exception 'Invalid archive request key'; end if;
 select * into c from public.archive_discovery_control where singleton for update;
 select * into r from public.archive_discovery_runs where request_key=p_request_key;
 if found then return jsonb_build_object('claimed',false,'reason','already_admitted','result',r.result); end if;
 if c.lease_until>now() then return jsonb_build_object('claimed',false,'reason','leased'); end if;
 if c.provider_retry_at>now() then return jsonb_build_object('claimed',false,'reason','provider_backoff'); end if;
 if (select count(*) from public.archive_discovery_runs where started_at>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC')>=c.daily_page_limit then
  return jsonb_build_object('claimed',false,'reason','daily_page_limit'); end if;
 select * into channel from public.archive_discovery_channels where next_attempt_at<=now()
  order by last_attempt_at nulls first,case when partition in ('recruitee','workable') then 0 else 1 end,partition limit 1 for update;
 if not found then return jsonb_build_object('claimed',false,'reason','not_due'); end if;
 update public.archive_discovery_runs set status='interrupted',finished_at=now() where id=c.current_run and status='running';
 insert into public.archive_discovery_runs(request_key,partition,pinned_index,page)
  values(p_request_key,channel.partition,channel.pinned_index,channel.next_page) returning * into r;
 update public.archive_discovery_channels set last_attempt_at=now() where partition=channel.partition;
 update public.archive_discovery_control set current_run=r.id,lease_until=now()+interval '5 minutes' where singleton;
 return jsonb_build_object('claimed',true,'id',r.id,'token',r.token,'partition',r.partition,
  'index',r.pinned_index,'page',r.page,'completedIndex',channel.completed_index);
end $$;

-- Candidate chunks, provenance, cursor and receipt commit in one transaction.
create function public.finish_archive_discovery(p_run uuid,p_token uuid,p_status text,p_page jsonb default null,p_error text default null,p_retry_at timestamptz default null) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare c public.archive_discovery_control; r public.archive_discovery_runs; channel public.archive_discovery_channels;
 v_index text; v_page integer; pages integer; total integer; added integer:=0; observations integer:=0;
 off integer; chunk jsonb; imported jsonb; receipt jsonb; budget bigint;
begin
 select * into c from public.archive_discovery_control where singleton for update;
 select * into r from public.archive_discovery_runs where id=p_run for update;
 if r.id is null or r.token is distinct from p_token then raise exception 'Archive lease lost'; end if;
 if r.status in ('completed','unchanged','failed') then return r.result; end if;
 if c.current_run is distinct from p_run or c.lease_until is null or c.lease_until<=now() or r.status<>'running' then raise exception 'Archive lease lost'; end if;
 select * into strict channel from public.archive_discovery_channels where partition=r.partition for update;
 if p_status='completed' then
  v_index:=p_page->'cursor'->>'index'; v_page:=(p_page->'cursor'->>'page')::integer; pages:=(p_page->>'totalPages')::integer;
  if coalesce(v_index,'') !~ '^CC-MAIN-20[0-9]{2}-[0-9]{2}$' or v_page is distinct from r.page
    or p_page->'cursor'->>'partition' is distinct from r.partition or (r.pinned_index is not null and r.pinned_index<>v_index)
    or pages is null or pages not between 0 and 1000000 or (pages>0 and v_page>=pages) or (pages=0 and v_page<>0)
    or p_page->'origin'->'cursor' is distinct from p_page->'cursor'
    or jsonb_typeof(p_page->'candidates') is distinct from 'array' or jsonb_array_length(p_page->'candidates')>5000
    or (pages=0 and jsonb_array_length(p_page->'candidates')<>0)
    or octet_length(p_page::text)>4000000 then raise exception 'Invalid archive page'; end if;
  total:=jsonb_array_length(p_page->'candidates');
  -- Same capacity lock used by catalogue publication; never raise its budget.
  perform pg_catalog.pg_advisory_xact_lock(730103006);
  select budget_bytes into strict budget from public.catalog_capacity_control where singleton;
  if pg_database_size(current_database())+octet_length(p_page::text)::bigint*3+8388608>budget then raise exception 'Catalogue storage budget reached'; end if;
  off:=0;
  while off<total loop
   select jsonb_agg(value order by ordinality) into chunk from jsonb_array_elements(p_page->'candidates') with ordinality where ordinality>off and ordinality<=off+500;
   imported:=public.import_source_candidates(p_page->'origin',chunk);
   added:=added+(imported->>'new_candidates')::integer; observations:=observations+(imported->>'new_observations')::integer;
   off:=off+500;
  end loop;
  update public.archive_discovery_channels set
   pinned_index=case when v_page+1<pages then v_index else null end,
   next_page=case when v_page+1<pages then v_page+1 else 0 end,
   completed_index=case when v_page+1<pages then completed_index else v_index end,
   next_attempt_at=case when v_page+1<pages then now() else now()+interval '7 days' end,failures=0 where partition=r.partition;
  receipt:=jsonb_build_object('id',r.id,'status',p_status,'partition',r.partition,'cursor',p_page->'cursor',
   'nextCursor',case when v_page+1<pages then jsonb_build_object('index',v_index,'partition',r.partition,'page',v_page+1) else null end,
   'candidates',total,'newCandidates',added,'newObservations',observations,'originId',p_page->'origin'->>'id');
 elsif p_status='unchanged' then
  if r.pinned_index is not null or channel.completed_index is null or p_page->>'index' is distinct from channel.completed_index then raise exception 'Invalid unchanged archive index'; end if;
  update public.archive_discovery_channels set next_attempt_at=now()+interval '7 days',failures=0 where partition=r.partition;
  receipt:=jsonb_build_object('id',r.id,'status',p_status,'partition',r.partition,'index',channel.completed_index);
 elsif p_status='failed' then
  update public.archive_discovery_channels set failures=failures+1,
   next_attempt_at=now()+make_interval(hours=>least(24,power(2,least(failures,5))::integer)) where partition=r.partition;
  if p_retry_at is not null then
   update public.archive_discovery_control set provider_retry_at=greatest(now()+interval '1 minute',least(now()+interval '24 hours',p_retry_at)) where singleton;
  end if;
  receipt:=jsonb_build_object('id',r.id,'status',p_status,'partition',r.partition,'reason',left(coalesce(p_error,'archive_unavailable'),200));
 else raise exception 'Invalid archive outcome'; end if;
 update public.archive_discovery_runs set status=p_status,finished_at=now(),result=receipt where id=p_run;
 update public.archive_discovery_control set lease_until=null where singleton;
 return receipt;
end $$;

revoke all on function public.claim_archive_discovery(text),public.finish_archive_discovery(uuid,uuid,text,jsonb,text,timestamptz) from public,anon,authenticated;
grant execute on function public.claim_archive_discovery(text),public.finish_archive_discovery(uuid,uuid,text,jsonb,text,timestamptz) to service_role;
