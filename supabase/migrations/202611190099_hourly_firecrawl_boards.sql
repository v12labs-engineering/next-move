alter table public.job_catalog_runs add column board_scan_mode text
  check (board_scan_mode in ('full','incremental'));

-- Checks are scoped to the catalog run. Only successfully published runs can
-- cause a later scan to skip a listing.
create table public.catalog_board_detail_checks (
  run_id uuid not null references public.job_catalog_runs(id) on delete cascade,
  source_id text not null references public.job_source_directory(id) on delete cascade,
  url text not null check (length(url) <= 2048 and url ~ '^https://[a-z0-9.-]+/'),
  fingerprint text not null check (fingerprint ~ '^[a-f0-9]{64}$'),
  checked_at timestamptz not null default now(),
  primary key (run_id,url)
);
create index catalog_board_detail_history on public.catalog_board_detail_checks(source_id,url,checked_at desc);
create index catalog_board_detail_retention on public.catalog_board_detail_checks(source_id,checked_at);
alter table public.catalog_board_detail_checks enable row level security;
revoke all on table public.catalog_board_detail_checks from public,anon,authenticated;
grant select,insert,update,delete on table public.catalog_board_detail_checks to service_role;

create function public.catalog_board_details_to_check(p_id uuid,p_token uuid,p_leads jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare task public.catalog_source_tasks; run public.job_catalog_runs; mode text; urls jsonb;
begin
  task:=public.lock_catalog_source_task(p_id,p_token);
  if task.source_id not in ('indiaboard:e2ehiring','indiaboard:shine','indiaboard:shipmates','indiaboard:technopark')
    then raise exception 'Invalid hourly Firecrawl source'; end if;
  if jsonb_typeof(p_leads) is distinct from 'array' or jsonb_array_length(p_leads)>20 then
    raise exception 'Invalid board detail batch';
  end if;

  select * into strict run from public.job_catalog_runs where id=task.run_id;
  mode:=run.board_scan_mode;
  if mode is null then
    mode:=case when exists(select 1 from public.job_catalog_runs r
      where r.source=task.source_id and r.status='succeeded' and r.board_scan_mode='full'
      and r.started_at > run.started_at-interval '24 hours') then 'incremental' else 'full' end;
    update public.job_catalog_runs set board_scan_mode=mode where id=run.id;
    delete from public.catalog_board_detail_checks c where c.source_id=task.source_id
      and c.checked_at<run.started_at-interval '7 days';
  end if;

  select coalesce(jsonb_agg(lead.url),'[]'::jsonb) into urls
  from jsonb_to_recordset(p_leads) as lead(url text,fingerprint text)
  left join lateral (
    select c.fingerprint from public.catalog_board_detail_checks c
    join public.job_catalog_runs prior on prior.id=c.run_id
    where c.source_id=task.source_id and c.url=lead.url and prior.status='succeeded'
      and mode='incremental'
    order by c.checked_at desc,c.run_id desc limit 1
  ) cached on true
  where cached.fingerprint is distinct from lead.fingerprint
    and not exists(select 1 from public.catalog_board_detail_checks c
      where c.run_id=run.id and c.url=lead.url);
  return jsonb_build_object('mode',mode,'urls',urls);
end $$;

create function public.checkpoint_catalog_board_source_work(p_id uuid,p_token uuid,p_page integer,p_next integer,
  p_jobs jsonb,p_fetched integer,p_rejected integer,p_requests integer,p_max_records integer,p_max_bytes bigint,
  p_max_pages integer,p_checked jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare task public.catalog_source_tasks; replay boolean; result jsonb;
begin
  task:=public.lock_catalog_source_task(p_id,p_token);
  if not exists(select 1 from public.job_catalog_runs r where r.id=task.run_id and r.board_scan_mode is not null)
    then raise exception 'Board scan has no refresh mode'; end if;
  if jsonb_typeof(p_checked) is distinct from 'array' or jsonb_array_length(p_checked)>20 then
    raise exception 'Invalid board detail checks';
  end if;
  replay:=exists(select 1 from public.catalog_source_task_receipts
    where task_id=p_id and operation='page' and page=p_page);
  result:=public.checkpoint_catalog_source_work(p_id,p_token,p_page,p_next,p_jobs,p_fetched,p_rejected,
    p_requests,p_max_records,p_max_bytes,p_max_pages);
  if not replay then
    insert into public.catalog_board_detail_checks(run_id,source_id,url,fingerprint)
    select task.run_id,task.source_id,detail.url,detail.fingerprint
    from jsonb_to_recordset(p_checked) as detail(url text,fingerprint text)
    on conflict (run_id,url) do nothing;
  end if;
  return result;
end $$;

revoke all on function public.catalog_board_details_to_check(uuid,uuid,jsonb),
  public.checkpoint_catalog_board_source_work(uuid,uuid,integer,integer,jsonb,integer,integer,integer,integer,bigint,integer,jsonb)
  from public,anon,authenticated;
grant execute on function public.catalog_board_details_to_check(uuid,uuid,jsonb),
  public.checkpoint_catalog_board_source_work(uuid,uuid,integer,integer,jsonb,integer,integer,integer,integer,bigint,integer,jsonb)
  to service_role;

update public.job_source_directory set collection_interval_seconds=3600
where kind='indiaboard' and id in ('indiaboard:e2ehiring','indiaboard:shine','indiaboard:shipmates','indiaboard:technopark');
