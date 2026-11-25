-- Keep the budget admission lock short. Publication itself may be slow and must
-- not block unrelated sources behind the global capacity lock.
create table public.catalog_storage_reservations (
  run_id uuid not null references public.job_catalog_runs(id),
  operation text not null check(operation in ('checkpoint','publish')),
  token uuid not null,
  bytes bigint not null check(bytes>=0),
  expires_at timestamptz not null,
  primary key(run_id,operation)
);
alter table public.catalog_storage_reservations enable row level security;
revoke all on public.catalog_storage_reservations from public,anon,authenticated;
grant all on public.catalog_storage_reservations to service_role;

create function public.reserve_catalog_storage(p_run uuid,p_token uuid,p_operation text,p_bytes bigint default 0) returns void
language plpgsql security invoker set search_path='' as $$
declare budget bigint; reserved bigint; needed bigint;
begin
  if p_operation not in ('checkpoint','publish') or p_bytes<0 then raise exception 'Invalid storage reservation'; end if;
  if not exists(select 1 from public.job_catalog_sources where current_run=p_run and lease_token=p_token and lease_until>now()) then
    raise exception 'Collection lease lost';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(730103006);
  delete from public.catalog_storage_reservations where expires_at<=now();
  select budget_bytes into strict budget from public.catalog_capacity_control where singleton;
  if p_operation='publish' then
    select coalesce(sum(octet_length(data::text)),0)::bigint*2 into needed from public.job_catalog_run_items where run_id=p_run;
  else needed:=p_bytes; end if;
  select coalesce(sum(bytes),0) into reserved from public.catalog_storage_reservations
    where (run_id,operation)<>(p_run,p_operation);
  if pg_catalog.pg_database_size(current_database())+needed+reserved>budget then
    if reserved>0 then raise exception 'Catalogue storage currently reserved; retry after existing source writes'; end if;
    raise exception 'Catalogue storage budget reached; collection paused to preserve database capacity';
  end if;
  insert into public.catalog_storage_reservations(run_id,operation,token,bytes,expires_at)
    values(p_run,p_operation,p_token,needed,now()+interval '5 minutes')
    on conflict(run_id,operation) do update set token=excluded.token,bytes=excluded.bytes,expires_at=excluded.expires_at;
end $$;

create or replace function public.checkpoint_catalog_page(p_run uuid,p_token uuid,p_page integer,p_next integer,
  p_jobs jsonb,p_fetched integer,p_rejected integer,p_requests integer) returns void
language plpgsql security invoker set search_path='' as $$
declare reservation public.catalog_storage_reservations; budget bigint; reserved bigint;
begin
  select * into reservation from public.catalog_storage_reservations where run_id=p_run and operation='checkpoint'
    and token=p_token and expires_at>now() for update;
  if found then
    if reservation.bytes<octet_length(p_jobs::text)::bigint*3 then raise exception 'Catalogue storage reservation too small'; end if;
  else
    -- Compatibility for the previous deployed collector during rollout. New
    -- collectors reserve before calling and avoid holding this lock for writes.
    perform pg_catalog.pg_advisory_xact_lock(730103006);
    select budget_bytes into strict budget from public.catalog_capacity_control where singleton;
    select coalesce(sum(bytes),0) into reserved from public.catalog_storage_reservations where expires_at>now();
    if pg_catalog.pg_database_size(current_database())+reserved+octet_length(p_jobs::text)::bigint*3>budget then
      raise exception 'Catalogue storage budget reached; collection paused to preserve database capacity';
    end if;
  end if;
  perform public.checkpoint_catalog_page_without_capacity(p_run,p_token,p_page,p_next,p_jobs,p_fetched,p_rejected,p_requests);
  delete from public.catalog_storage_reservations where run_id=p_run and operation='checkpoint' and token=p_token;
end $$;

create or replace function public.finish_catalog_run(p_run uuid,p_token uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare reservation public.catalog_storage_reservations; budget bigint; reserved bigint; publishing bigint; result jsonb;
begin
  select * into reservation from public.catalog_storage_reservations where run_id=p_run and operation='publish'
    and token=p_token and expires_at>now() for update;
  select coalesce(sum(octet_length(data::text)),0)::bigint*2 into publishing from public.job_catalog_run_items where run_id=p_run;
  if reservation.run_id is not null then
    if reservation.bytes<publishing then raise exception 'Catalogue storage reservation too small'; end if;
  else
    perform pg_catalog.pg_advisory_xact_lock(730103006);
    select budget_bytes into strict budget from public.catalog_capacity_control where singleton;
    select coalesce(sum(bytes),0) into reserved from public.catalog_storage_reservations where expires_at>now();
    if pg_catalog.pg_database_size(current_database())+reserved+publishing>budget then
      raise exception 'Catalogue storage budget reached; publication paused to preserve database capacity';
    end if;
  end if;
  result:=public.finish_catalog_run_without_capacity(p_run,p_token);
  delete from public.catalog_storage_reservations where run_id=p_run and operation='publish' and token=p_token;
  return result;
end $$;
revoke all on function public.reserve_catalog_storage(uuid,uuid,text,bigint) from public,anon,authenticated;
grant execute on function public.reserve_catalog_storage(uuid,uuid,text,bigint) to service_role;
