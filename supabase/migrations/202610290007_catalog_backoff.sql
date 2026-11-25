-- Persist throttling across worker invocations, not only inside an HTTP request.
alter table public.job_catalog_runs add column retry_at timestamptz;
update public.job_catalog_runs set retry_at=now()+interval '15 minutes'
where status='paused' and last_error like '%429%';

create or replace function public.begin_catalog_run(p_source text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare s public.job_catalog_sources; r public.job_catalog_runs; token uuid:=gen_random_uuid();
begin
  if not exists(select 1 from public.job_source_directory where id=p_source and enabled) then
    raise exception 'Source is not enabled';
  end if;
  insert into public.job_catalog_sources(id) values(p_source) on conflict do nothing;
  select * into s from public.job_catalog_sources where id=p_source for update;
  if s.lease_until>now() then return null; end if;
  select * into r from public.job_catalog_runs where id=s.current_run and status<>'succeeded';
  if r.id is not null and r.retry_at>now() then
    return jsonb_build_object('deferred',true,'retry_at',r.retry_at);
  end if;
  if r.id is null then
    insert into public.job_catalog_runs(source) values(p_source) returning * into r;
  end if;
  update public.job_catalog_runs set attempts=attempts+1,status='running',retry_at=null where id=r.id returning * into r;
  update public.job_catalog_sources set current_run=r.id,lease_token=token,
    lease_until=now()+interval '5 minutes',last_started_at=now() where id=p_source;
  return to_jsonb(r)||jsonb_build_object('token',token);
end $$;

create function public.defer_catalog_run(p_run uuid,p_token uuid,p_error text,p_requests integer,p_retry_at timestamptz) returns void
language plpgsql security invoker set search_path='' as $$
begin
  perform public.pause_catalog_run(p_run,p_token,p_error,p_requests);
  update public.job_catalog_runs set retry_at=greatest(now()+interval '1 minute',coalesce(p_retry_at,now()+interval '15 minutes')) where id=p_run;
end $$;
revoke all on function public.defer_catalog_run(uuid,uuid,text,integer,timestamptz) from public,anon,authenticated;
grant execute on function public.defer_catalog_run(uuid,uuid,text,integer,timestamptz) to service_role;
