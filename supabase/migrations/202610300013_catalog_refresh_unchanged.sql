-- Refresh unchanged observations without rewriting the description/TOAST data.
create index job_catalog_source_id_idx on public.job_catalog(source,id);
create or replace function public.finish_catalog_run_without_capacity(p_run uuid,p_token uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare s public.job_catalog_sources; r public.job_catalog_runs; added integer; changed integer; expired integer; published integer; changed_ids text[];
begin
  select * into s from public.job_catalog_sources where current_run=p_run for update;
  if s.id is null or s.lease_token is distinct from p_token or s.lease_until<=now() then raise exception 'Collection lease lost'; end if;
  select * into r from public.job_catalog_runs where id=p_run;
  if r.next_page is not null then raise exception 'Collection is incomplete'; end if;
  select count(*) into added from public.job_catalog_run_items i left join public.job_catalog j on j.id=i.id where i.run_id=p_run and j.id is null;
  -- Keep change detection on snapshot IDs. The OFFSET boundary prevents a
  -- generic plan from materializing every description-bearing catalogue row.
  select array_agg(i.id) into changed_ids from public.job_catalog_run_items i
    cross join lateral (
      select to_jsonb(j)-array['discovered_at','last_checked_at','is_active','sponsor_verified'] as fields
      from public.job_catalog j where j.id=i.id offset 0
    ) existing
    where i.run_id=p_run and existing.fields is distinct from (i.data-'sponsor_verified');
  changed:=coalesce(cardinality(changed_ids),0);
  insert into public.job_catalog(id,title,company,country,city,url,description,work_mode,visa_signal,sponsorship_evidence,sponsor_verified,source,posted_at,is_active,last_checked_at)
    select x.id,x.title,x.company,x.country,x.city,x.url,x.description,x.work_mode,x.visa_signal::public.visa_confidence,x.sponsorship_evidence,false,s.id,x.posted_at,true,i.observed_at
    from public.job_catalog_run_items i cross join lateral jsonb_to_record(i.data)
    as x(id text,title text,company text,country text,city text,url text,description text,work_mode text,visa_signal text,sponsorship_evidence text,posted_at timestamptz)
    where i.run_id=p_run
    on conflict(id) do update set title=excluded.title,company=excluded.company,country=excluded.country,
      city=excluded.city,url=excluded.url,description=excluded.description,work_mode=excluded.work_mode,
      visa_signal=excluded.visa_signal,sponsorship_evidence=excluded.sponsorship_evidence,
      posted_at=excluded.posted_at,is_active=true,last_checked_at=excluded.last_checked_at
    where job_catalog.id=any(changed_ids);
  -- An unchanged job needs a fresh observation, not another description write.
  update public.job_catalog j set last_checked_at=i.observed_at,is_active=true
    from public.job_catalog_run_items i where i.run_id=p_run and j.id=i.id and j.source=s.id
    and (j.last_checked_at is distinct from i.observed_at or j.is_active is distinct from true);
  select count(*) into published from public.job_catalog_run_items where run_id=p_run;
  update public.job_catalog set is_active=false where source=s.id and is_active and
    not exists(select 1 from public.job_catalog_run_items i where i.run_id=p_run and i.id=job_catalog.id);
  get diagnostics expired=row_count;
  update public.job_catalog_runs set status='succeeded',finished_at=now(),new_count=added,
    updated_count=changed,expired_count=expired where id=p_run returning * into r;
  update public.job_catalog_sources set last_success_at=now(),last_error=null,published_count=published,
    last_complete=true,lease_until=null,lease_token=null where id=s.id;
  delete from public.job_catalog_run_items where run_id=p_run;
  return to_jsonb(r);
end $$;

