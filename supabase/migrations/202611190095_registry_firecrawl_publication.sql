-- Registry maps are bounded observations. Publish individual verified jobs
-- without claiming a complete inventory or retiring absent jobs.
create function public.publish_registry_firecrawl_india(p_jobs jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare observed timestamptz := now(); budget bigint; result jsonb;
begin
  if jsonb_typeof(p_jobs) is distinct from 'array' or jsonb_array_length(p_jobs)>100
    or octet_length(p_jobs::text)>3145728 then
    raise exception 'Invalid registry publication batch';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_jobs) job
    where job->>'source' is distinct from 'firecrawl:registry'
      or job->>'country' is distinct from 'India'
      or coalesce(job->>'id','') !~ '^[0-9a-f]{64}$'
      or coalesce(job->>'url','') !~ '^https://[a-z0-9.-]+/'
      or length(btrim(coalesce(job->>'title','')))=0
      or length(btrim(coalesce(job->>'company','')))=0
      or length(coalesce(job->>'description',''))<100
      or not coalesce((job->>'posted_at')::timestamptz between observed-interval '30 days' and observed,false)
  ) then
    raise exception 'Registry publication requires a fresh India job detail';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(730103006);
  select budget_bytes into strict budget from public.catalog_capacity_control where singleton;
  if pg_database_size(current_database())+octet_length(p_jobs::text)::bigint*3>budget then
    raise exception 'Catalogue storage budget reached';
  end if;

  with eligible as materialized (
    select distinct on (x.id) x.*, existing.id is null as is_new
    from jsonb_to_recordset(p_jobs) x(id text,title text,company text,city text,url text,description text,
      work_mode text,visa_signal text,sponsorship_evidence text,posted_at timestamptz,posting_details jsonb)
    left join public.job_catalog existing on existing.id=x.id
    where (existing.id is null or existing.source='firecrawl:registry')
      and not exists (
        select 1 from public.job_catalog other
        where other.country='India' and other.id<>x.id
          and regexp_replace(split_part(other.url,'#',1),'/+(\?|$)','\1')
            =regexp_replace(split_part(x.url,'#',1),'/+(\?|$)','\1')
      )
    order by x.id,x.posted_at desc
  ), stored as (
    insert into public.job_catalog as current_job
      (id,title,company,country,city,url,description,work_mode,visa_signal,sponsorship_evidence,
       sponsor_verified,source,posted_at,is_active,last_checked_at,posting_details)
    select id,title,company,'India',city,url,description,work_mode,visa_signal::public.visa_confidence,
      sponsorship_evidence,false,'firecrawl:registry',posted_at,true,observed,posting_details
    from eligible
    on conflict (id) do update set title=excluded.title,company=excluded.company,city=excluded.city,
      description=excluded.description,description_ref=null,posted_at=excluded.posted_at,
      work_mode=excluded.work_mode,visa_signal=excluded.visa_signal,sponsorship_evidence=excluded.sponsorship_evidence,
      posting_details=excluded.posting_details,is_active=true,last_checked_at=observed
    where current_job.source='firecrawl:registry'
      and (current_job.last_checked_at is null or current_job.last_checked_at<=observed)
    returning id
  )
  select jsonb_build_object(
    'newRecords',count(*) filter(where eligible.is_new),
    'newIds',coalesce(jsonb_agg(stored.id order by stored.id) filter(where eligible.is_new),'[]'::jsonb),
    'verifiedRecords',count(*)
  ) into result from stored join eligible using(id);
  return result;
end $$;

revoke all on function public.publish_registry_firecrawl_india(jsonb) from public,anon,authenticated;
grant execute on function public.publish_registry_firecrawl_india(jsonb) to service_role;
