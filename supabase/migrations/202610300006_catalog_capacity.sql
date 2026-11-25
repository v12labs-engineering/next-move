-- Operator diagnostics and queue availability; no customer data is returned.
create function public.catalog_storage_usage() returns jsonb
language sql stable security invoker set search_path='' as $$
  select jsonb_build_object(
    'database_bytes',pg_catalog.pg_database_size(current_database()),
    'catalog_bytes',pg_catalog.pg_total_relation_size('public.job_catalog'),
    'staged_bytes',pg_catalog.pg_total_relation_size('public.job_catalog_run_items'));
$$;
create function public.catalog_collection_availability(p_after text default null,p_limit integer default 500)
returns table(id text,lease_until timestamptz,retry_at timestamptz)
language sql stable security invoker set search_path='' as $$
  select d.id,s.lease_until,case when r.status<>'succeeded' then r.retry_at end
  from public.job_source_directory d left join public.job_catalog_sources s on s.id=d.id
  left join public.job_catalog_runs r on r.id=s.current_run
  where d.enabled and (p_after is null or d.id>p_after)
  order by d.id limit least(greatest(p_limit,1),500);
$$;
revoke all on function public.catalog_storage_usage(),public.catalog_collection_availability(text,integer) from public,anon,authenticated;
grant execute on function public.catalog_storage_usage(),public.catalog_collection_availability(text,integer) to service_role;

create table public.catalog_capacity_control (
  singleton boolean primary key default true check(singleton),
  budget_bytes bigint not null default 419430400 check(budget_bytes>=52428800)
);
insert into public.catalog_capacity_control(singleton) values(true);
alter table public.catalog_capacity_control enable row level security;
revoke all on public.catalog_capacity_control from public,anon,authenticated;
grant all on public.catalog_capacity_control to service_role;

-- Serialize catalogue growth so concurrent collectors cannot all spend the same
-- headroom. Existing customer records and listing histories are never removed.
alter function public.checkpoint_catalog_page(uuid,uuid,integer,integer,jsonb,integer,integer,integer)
  rename to checkpoint_catalog_page_without_capacity;
create function public.checkpoint_catalog_page(p_run uuid,p_token uuid,p_page integer,p_next integer,
  p_jobs jsonb,p_fetched integer,p_rejected integer,p_requests integer) returns void
language plpgsql security invoker set search_path='' as $$
declare budget bigint;
begin
  perform pg_catalog.pg_advisory_xact_lock(730103006);
  select budget_bytes into strict budget from public.catalog_capacity_control where singleton;
  if pg_catalog.pg_database_size(current_database())+octet_length(p_jobs::text)::bigint*3>budget then
    raise exception 'Catalogue storage budget reached; collection paused to preserve database capacity';
  end if;
  perform public.checkpoint_catalog_page_without_capacity(p_run,p_token,p_page,p_next,p_jobs,p_fetched,p_rejected,p_requests);
end $$;

alter function public.finish_catalog_run(uuid,uuid) rename to finish_catalog_run_without_capacity;
create function public.finish_catalog_run(p_run uuid,p_token uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare budget bigint; publishing bigint;
begin
  perform pg_catalog.pg_advisory_xact_lock(730103006);
  select budget_bytes into strict budget from public.catalog_capacity_control where singleton;
  select coalesce(sum(octet_length(data::text)),0)::bigint*2 into publishing
    from public.job_catalog_run_items where run_id=p_run;
  if pg_catalog.pg_database_size(current_database())+publishing>budget then
    raise exception 'Catalogue storage budget reached; publication paused to preserve database capacity';
  end if;
  return public.finish_catalog_run_without_capacity(p_run,p_token);
end $$;
revoke all on function public.checkpoint_catalog_page(uuid,uuid,integer,integer,jsonb,integer,integer,integer),public.finish_catalog_run(uuid,uuid) from public,anon,authenticated;
grant execute on function public.checkpoint_catalog_page(uuid,uuid,integer,integer,jsonb,integer,integer,integer),public.finish_catalog_run(uuid,uuid) to service_role;
