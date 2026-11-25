-- Historical directory metadata is separate from current listings and customers.
create table public.source_discovery_origins (
  id text primary key,
  metadata jsonb not null,
  imported_at timestamptz not null default now()
);
create table public.source_candidates (
  id text primary key,
  kind text not null check(kind in ('ashby','greenhouse','lever')),
  board text not null check(board ~ '^[a-z0-9][a-z0-9._-]{0,99}$'),
  expected_company text,
  status text not null default 'imported' check(status in
    ('imported','validating','verified','empty','needs_review','deferred','missing','invalid','activated')),
  created_at timestamptz not null default now(),
  next_attempt_at timestamptz not null default now(),
  attempts integer not null default 0,
  lease_token uuid,
  lease_until timestamptz,
  validated_at timestamptz,
  validation jsonb,
  activated_at timestamptz,
  approval_note text,
  check(id=kind||':'||board),
  check(expected_company is null or length(expected_company) between 1 and 300)
);
create index source_candidates_due on public.source_candidates(next_attempt_at,id)
  where status not in ('activated','invalid');
create table public.source_candidate_observations (
  candidate_id text not null references public.source_candidates(id),
  origin_id text not null references public.source_discovery_origins(id),
  evidence_url text not null,
  expected_company text,
  historical_checked_at date not null,
  primary key(candidate_id,origin_id)
);
create table public.source_candidate_checks (
  id uuid primary key,
  candidate_id text not null references public.source_candidates(id),
  checked_at timestamptz not null default now(),
  result jsonb not null
);
create index source_candidate_checks_time on public.source_candidate_checks(candidate_id,checked_at desc);

alter table public.source_discovery_origins enable row level security;
alter table public.source_candidates enable row level security;
alter table public.source_candidate_observations enable row level security;
alter table public.source_candidate_checks enable row level security;
revoke all on public.source_discovery_origins,public.source_candidates,
  public.source_candidate_observations,public.source_candidate_checks from public,anon,authenticated;
grant all on public.source_discovery_origins,public.source_candidates,
  public.source_candidate_observations,public.source_candidate_checks to service_role;

create function public.import_source_candidates(p_origin jsonb,p_candidates jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare item jsonb; added integer:=0; observed integer:=0; affected integer; origin_id text:=p_origin->>'id';
begin
  if coalesce(length(origin_id),0) not between 1 and 200 or
    coalesce(p_origin->>'revision','') !~ '^[a-f0-9]{40}$' or
    coalesce(p_origin->>'sha256','') !~ '^[a-f0-9]{64}$' or
    coalesce(p_origin->>'license','')='' or coalesce(p_origin->>'attribution','')='' or
    jsonb_typeof(p_candidates) is distinct from 'array' or jsonb_array_length(p_candidates)>500 then
    raise exception 'Invalid candidate import';
  end if;
  insert into public.source_discovery_origins(id,metadata) values(origin_id,p_origin) on conflict do nothing;
  if (select metadata from public.source_discovery_origins where id=origin_id) is distinct from p_origin then
    raise exception 'Origin revision metadata changed';
  end if;
  for item in select * from jsonb_array_elements(p_candidates) loop
    insert into public.source_candidates(id,kind,board,expected_company)
      values(item->>'id',item->>'kind',item->>'board',item->>'expected_company') on conflict do nothing;
    get diagnostics affected=row_count; added:=added+affected;
    -- Later provenance can supply a historical label, never overwrite live validation.
    update public.source_candidates set expected_company=item->>'expected_company'
      where id=item->>'id' and expected_company is null and item->>'expected_company' is not null;
    if item->>'id' is distinct from (item->>'kind')||':'||(item->>'board') or
      coalesce(item->>'evidence_url','') !~ '^https://' or
      (item->>'historical_checked_at')::date>current_date then raise exception 'Invalid observation'; end if;
    insert into public.source_candidate_observations(candidate_id,origin_id,evidence_url,expected_company,historical_checked_at)
      values(item->>'id',origin_id,item->>'evidence_url',item->>'expected_company',(item->>'historical_checked_at')::date)
      on conflict do nothing;
    get diagnostics affected=row_count; observed:=observed+affected;
  end loop;
  return jsonb_build_object('new_candidates',added,'new_observations',observed,'rows',jsonb_array_length(p_candidates));
end $$;

create function public.claim_source_candidate(p_id text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare c public.source_candidates; token uuid:=gen_random_uuid();
begin
  select * into c from public.source_candidates where id=p_id for update skip locked;
  if c.id is null or c.status in ('activated','invalid') or c.next_attempt_at>now() or c.lease_until>now() then return null; end if;
  update public.source_candidates set status='validating',lease_token=token,
    lease_until=now()+interval '5 minutes',attempts=attempts+1 where id=p_id;
  return to_jsonb(c)||jsonb_build_object('token',token);
end $$;

create function public.finish_source_candidate(p_id text,p_token uuid,p_result jsonb) returns void
language plpgsql security invoker set search_path='' as $$
declare c public.source_candidates; result_status text:=p_result->>'status';
begin
  select * into c from public.source_candidates where id=p_id for update;
  if c.id is null or c.lease_token is distinct from p_token or c.lease_until<=now() then raise exception 'Discovery lease lost'; end if;
  if result_status is null or result_status not in ('verified','empty','needs_review','deferred','missing','invalid') or
    jsonb_typeof(p_result->'evidence') is distinct from 'array' or
    jsonb_typeof(p_result->'countries') is distinct from 'array' or
    coalesce((p_result->>'fetched_count')::integer,-1)<0 or coalesce((p_result->>'accepted_count')::integer,-1)<0 or
    (p_result->>'next_attempt_at')::timestamptz is null then raise exception 'Invalid validation result'; end if;
  if result_status='verified' and (coalesce(length(p_result->>'company'),0) not between 1 and 300 or
    coalesce((p_result->>'accepted_count')::integer,0)<1 or
    jsonb_array_length(p_result->'countries')<1 or jsonb_array_length(p_result->'evidence')<2) then
    raise exception 'Verified source needs current employer and posting evidence';
  end if;
  insert into public.source_candidate_checks(id,candidate_id,result) values(p_token,p_id,p_result);
  update public.source_candidates set status=result_status,validation=p_result,validated_at=now(),
    next_attempt_at=(p_result->>'next_attempt_at')::timestamptz,lease_token=null,lease_until=null where id=p_id;
end $$;

create function public.activate_source_candidate(p_id text,p_note text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare c public.source_candidates; source public.job_source_directory; countries text[];
begin
  if coalesce(length(trim(p_note)),0) not between 10 and 1000 then raise exception 'Source review note required'; end if;
  select * into c from public.source_candidates where id=p_id for update;
  if c.id is null then raise exception 'Candidate not found'; end if;
  if c.status='activated' then
    select * into source from public.job_source_directory where id=p_id;
    return to_jsonb(source);
  end if;
  if c.status<>'verified' or c.validated_at<now()-interval '24 hours' or c.lease_until>now() then
    raise exception 'Recent successful live validation required';
  end if;
  select array_agg(value) into countries from jsonb_array_elements_text(c.validation->'countries');
  insert into public.job_source_directory(id,kind,board,company,enabled,discovered_url,countries)
    values(c.id,c.kind,c.board,c.validation->>'company',true,
      (c.validation->'evidence'->0)->>'url',countries)
    on conflict(id) do update set enabled=true,
      company=case when job_source_directory.enabled then job_source_directory.company else excluded.company end,
      countries=array(select distinct unnest(job_source_directory.countries||excluded.countries))
    returning * into source;
  update public.source_candidates set status='activated',activated_at=now(),approval_note=trim(p_note) where id=p_id;
  return to_jsonb(source);
end $$;

revoke all on function public.import_source_candidates(jsonb,jsonb),public.claim_source_candidate(text),
  public.finish_source_candidate(text,uuid,jsonb),public.activate_source_candidate(text,text) from public,anon,authenticated;
grant execute on function public.import_source_candidates(jsonb,jsonb),public.claim_source_candidate(text),
  public.finish_source_candidate(text,uuid,jsonb),public.activate_source_candidate(text,text) to service_role;
