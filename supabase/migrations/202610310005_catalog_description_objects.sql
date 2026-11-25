-- Public listing bodies live in immutable, checksummed object packs. Personal
-- profiles, resumes, packets and history remain in their existing private tables.
alter table public.job_catalog add column description_ref jsonb;
create table public.catalog_content_packs (
  id text primary key check(id ~ '^[a-f0-9]{64}$'),
  bytes integer not null check(bytes between 1 and 524288),
  ready boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.catalog_content_packs enable row level security;
revoke all on public.catalog_content_packs from public,anon,authenticated;
grant all on public.catalog_content_packs to service_role;

create function public.reserve_catalog_content(p_id text,p_bytes integer) returns void
language plpgsql security invoker set search_path='' as $$
declare used bigint; existing integer;
begin
  if p_id !~ '^[a-f0-9]{64}$' or p_bytes not between 1 and 524288 then raise exception 'Invalid content pack'; end if;
  perform pg_catalog.pg_advisory_xact_lock(730103105);
  select bytes into existing from public.catalog_content_packs where id=p_id;
  if existing is not null then
    if existing<>p_bytes then raise exception 'Content pack mismatch'; end if;
    return;
  end if;
  select coalesce(sum(bytes),0) into used from public.catalog_content_packs;
  -- Keep a separate bounded allowance below the existing free 1 GB object quota.
  if used+p_bytes>805306368 then raise exception 'Catalogue object storage budget reached'; end if;
  insert into public.catalog_content_packs(id,bytes) values(p_id,p_bytes);
end $$;

create function public.confirm_catalog_content(p_id text,p_bytes integer) returns void
language plpgsql security invoker set search_path='' as $$
begin
  update public.catalog_content_packs set ready=true where id=p_id and bytes=p_bytes;
  if not found then raise exception 'Content reservation missing'; end if;
end $$;

create function public.valid_catalog_description_ref(p_ref jsonb) returns boolean
language sql stable security invoker set search_path='' as $$
 select p_ref is null or p_ref='null'::jsonb or (
   jsonb_typeof(p_ref)='object' and p_ref->>'v'='1'
   and p_ref->>'pack' ~ '^[a-f0-9]{64}$' and p_ref->>'sha256' ~ '^[a-f0-9]{64}$'
   and (p_ref->>'offset')::integer>=0 and (p_ref->>'length')::integer>0
   and (p_ref->>'bytes')::integer between 1 and 240000
   and exists(select 1 from public.catalog_content_packs p where p.id=p_ref->>'pack' and p.ready
     and (p_ref->>'offset')::integer+(p_ref->>'length')::integer<=p.bytes)
 );
$$;

create function public.archive_catalog_description_batch(p_limit integer default 128) returns jsonb
language sql stable security invoker set search_path='' as $$
 select coalesce(jsonb_agg(to_jsonb(x)),'[]') from
   (select id,description from public.job_catalog where description_ref is null and description<>''
     order by ctid desc limit least(greatest(p_limit,1),256)) x;
$$;

create function public.attach_catalog_description_refs(p_rows jsonb) returns integer
language plpgsql security invoker set search_path='' as $$
declare changed integer;
begin
  if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)>256 then raise exception 'Invalid archive batch'; end if;
  if exists(select 1 from jsonb_array_elements(p_rows) x where
    not coalesce(public.valid_catalog_description_ref(x->'description_ref'),false) or jsonb_typeof(x->'description_ref') is distinct from 'object')
    then raise exception 'Unverified description reference'; end if;
  update public.job_catalog j set description='',description_ref=x.description_ref
    from jsonb_to_recordset(p_rows) as x(id text,description_ref jsonb)
    where j.id=x.id and j.description_ref is null
      and encode(sha256(convert_to(j.description,'UTF8')),'hex')=x.description_ref->>'sha256';
  get diagnostics changed=row_count;
  return changed;
end $$;

-- Compare logical description content, not the location of its immutable pack.
create function public.catalog_description_fingerprint(p_description text,p_ref jsonb) returns text
language sql immutable set search_path='' as $$
 select case when p_ref is not null and p_ref<>'null'::jsonb then p_ref->>'sha256'
   else encode(sha256(convert_to(coalesce(p_description,''),'UTF8')),'hex') end;
$$;

create function public.catalog_description_write_guard() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  -- Preserve compatibility with old operator publishers during rollout.
  if new.description<>'' then new.description_ref:=null;
  elsif not coalesce(public.valid_catalog_description_ref(new.description_ref),false) then
    raise exception 'Unverified description reference';
  end if;
  return new;
end $$;
create trigger catalog_description_write_guard before insert or update of description,description_ref on public.job_catalog
for each row execute function public.catalog_description_write_guard();

create or replace function public.finish_catalog_run_without_capacity(p_run uuid,p_token uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare s public.job_catalog_sources; r public.job_catalog_runs; added integer; changed integer; expired integer; published integer; changed_ids text[];
begin
  select * into s from public.job_catalog_sources where current_run=p_run for update;
  if s.id is null or s.lease_token is distinct from p_token or s.lease_until<=now() then raise exception 'Collection lease lost'; end if;
  select * into r from public.job_catalog_runs where id=p_run;
  if r.next_page is not null then raise exception 'Collection is incomplete'; end if;
  if exists(select 1 from public.job_catalog_run_items i where i.run_id=p_run
    and not coalesce(public.valid_catalog_description_ref(i.data->'description_ref'),false))
    then raise exception 'Unverified description reference'; end if;
  select count(*) into added from public.job_catalog_run_items i left join public.job_catalog j on j.id=i.id where i.run_id=p_run and j.id is null;
  select array_agg(i.id) into changed_ids from public.job_catalog_run_items i
    cross join lateral (
      select to_jsonb(j)-array['discovered_at','last_checked_at','is_active','sponsor_verified','posted_at','description','description_ref'] as fields,
        j.posted_at,public.catalog_description_fingerprint(j.description,j.description_ref) fingerprint
      from public.job_catalog j where j.id=i.id offset 0
    ) existing
    where i.run_id=p_run and (existing.fields is distinct from
        (i.data-array['sponsor_verified','posted_at','description','description_ref'])
      or existing.posted_at is distinct from (i.data->>'posted_at')::timestamptz
      or existing.fingerprint is distinct from public.catalog_description_fingerprint(i.data->>'description',i.data->'description_ref'));
  changed:=coalesce(cardinality(changed_ids),0);
  insert into public.job_catalog(id,title,company,country,city,url,description,description_ref,work_mode,visa_signal,sponsorship_evidence,sponsor_verified,source,posted_at,is_active,last_checked_at)
    select x.id,x.title,x.company,x.country,x.city,x.url,x.description,x.description_ref,x.work_mode,x.visa_signal::public.visa_confidence,x.sponsorship_evidence,false,s.id,x.posted_at,true,i.observed_at
    from public.job_catalog_run_items i cross join lateral jsonb_to_record(i.data)
    as x(id text,title text,company text,country text,city text,url text,description text,description_ref jsonb,work_mode text,visa_signal text,sponsorship_evidence text,posted_at timestamptz)
    where i.run_id=p_run
    on conflict(id) do update set title=excluded.title,company=excluded.company,country=excluded.country,
      city=excluded.city,url=excluded.url,description=excluded.description,description_ref=excluded.description_ref,work_mode=excluded.work_mode,
      visa_signal=excluded.visa_signal,sponsorship_evidence=excluded.sponsorship_evidence,
      posted_at=excluded.posted_at,is_active=true,last_checked_at=excluded.last_checked_at
    where job_catalog.id=any(changed_ids);
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

revoke all on function public.reserve_catalog_content(text,integer),public.confirm_catalog_content(text,integer),
  public.valid_catalog_description_ref(jsonb),public.archive_catalog_description_batch(integer),
  public.attach_catalog_description_refs(jsonb),public.catalog_description_fingerprint(text,jsonb),public.catalog_description_write_guard() from public,anon,authenticated;
grant execute on function public.reserve_catalog_content(text,integer),public.confirm_catalog_content(text,integer),
  public.valid_catalog_description_ref(jsonb),public.archive_catalog_description_batch(integer),
  public.attach_catalog_description_refs(jsonb),public.catalog_description_fingerprint(text,jsonb),public.catalog_description_write_guard() to service_role;
