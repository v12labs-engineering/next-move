-- Temporary, private batch receipts. No resume or description text is stored.
alter table public.account_match_state add column build_cursor jsonb, add column build_facts jsonb;
create table public.account_match_batches (
  user_id uuid not null references auth.users(id) on delete cascade,
  token uuid not null,
  batch integer not null,
  payload jsonb not null,
  primary key(user_id,token,batch)
);
alter table public.account_match_batches enable row level security;
revoke all on public.account_match_batches from public,anon,authenticated;
grant select,delete on public.account_match_batches to service_role;

create function public.begin_account_match_build(p_user uuid,p_token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.account_match_state; p public.account_profiles; countries jsonb;
begin
  -- One transactional read avoids mixing a newly saved profile with old countries.
  select * into p from public.account_profiles where user_id=p_user for share;
  if not found then raise exception 'Matching profile superseded'; end if;
  select * into s from public.account_match_state where user_id=p_user for update;
  if s.generation=p_token then return null; end if;
  if s.token is distinct from p_token or s.lease_until<=now() or s.building_version is distinct from p.version then
    raise exception 'Matching run superseded'; end if;
  delete from public.account_match_batches where user_id=p_user and token<>p_token;
  if s.build_cursor->>'token' is distinct from p_token::text then
    s.build_cursor:=jsonb_build_object('token',p_token,'batch',0,'country',0,'after',null,'savedOffset',0,
      'phase','catalog','measuredAt',now());
  end if;
  update public.account_match_state set build_cursor=s.build_cursor,lease_until=now()+interval '10 minutes' where user_id=p_user;
  select coalesce(jsonb_agg(jsonb_build_object('country',c.country,'added_at',c.added_at) order by c.country),'[]')
    into countries from public.account_countries c where c.user_id=p_user;
  return jsonb_build_object('cursor',s.build_cursor,'profile',jsonb_build_object('data',p.data,'version',p.version,'countries',countries),'facts',s.build_facts);
end $$;

create function public.checkpoint_account_match_batch(p_user uuid,p_token uuid,p_batch integer,p_next jsonb,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.account_match_state; budget bigint;
begin
  select * into s from public.account_match_state where user_id=p_user for update;
  if s.token is distinct from p_token or s.lease_until<=now() then raise exception 'Matching run superseded'; end if;
  if (s.build_cursor->>'batch')::integer>p_batch then return s.build_cursor; end if;
  if (s.build_cursor->>'batch')::integer is distinct from p_batch
    or (p_next->>'batch')::integer is distinct from p_batch+1
    or p_next->>'token' is distinct from p_token::text then raise exception 'Invalid matching checkpoint'; end if;
  if octet_length(p_payload::text)>2000000 or jsonb_array_length(p_payload->'jobs')>200
    or exists(select 1 from jsonb_array_elements(p_payload->'jobs') j where j ? 'description')
    then raise exception 'Invalid matching batch'; end if;
  perform pg_advisory_xact_lock(730103006);
  select budget_bytes into strict budget from public.catalog_capacity_control where singleton;
  if pg_database_size(current_database())+octet_length(p_payload::text)::bigint*3>budget then
    raise exception 'Matching checkpoint storage budget reached'; end if;
  insert into public.account_match_batches values(p_user,p_token,p_batch,p_payload);
  update public.account_match_state set build_cursor=p_next,lease_until=now()+interval '10 minutes' where user_id=p_user;
  return p_next;
end $$;
-- Cleanup on publication, failure or replacement. Retries of a still-owned run
-- retain their receipts; terminal failure preserves only the published generation.
create function public.cleanup_matching_batches() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if old.token is not null and old.token is distinct from new.token then
    delete from public.account_match_batches where user_id=new.user_id and token=old.token;
  end if;
  return null;
end $$;
create trigger cleanup_matching_batches after update on public.account_match_state
  for each row execute function public.cleanup_matching_batches();
revoke all on function public.begin_account_match_build(uuid,uuid),public.checkpoint_account_match_batch(uuid,uuid,integer,jsonb,jsonb),
  public.cleanup_matching_batches() from public,anon,authenticated;
grant execute on function public.begin_account_match_build(uuid,uuid),public.checkpoint_account_match_batch(uuid,uuid,integer,jsonb,jsonb) to service_role;

-- Private profile features are scoped to one fenced build and removed with it.
-- They never enter the shared public feature cache or workflow event arguments.
create function public.save_account_match_profile(p_user uuid,p_token uuid,p_facts jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare budget bigint;
begin
  if octet_length(p_facts::text)>4000000 then raise exception 'Matching profile features too large'; end if;
  -- Preserve state -> storage lock ordering used by checkpoint/publication writes.
  perform 1 from public.account_match_state where user_id=p_user for update;
  perform pg_advisory_xact_lock(730103006);
  select budget_bytes into strict budget from public.catalog_capacity_control where singleton;
  if pg_database_size(current_database())+octet_length(p_facts::text)::bigint*3>budget then raise exception 'Matching profile storage budget reached'; end if;
  update public.account_match_state set build_facts=p_facts
    where user_id=p_user and token=p_token and lease_until>now();
  if not found then raise exception 'Matching run superseded'; end if;
end $$;
create function public.clear_matching_profile() returns trigger
language plpgsql set search_path='' as $$
begin
  if old.token is distinct from new.token then new.build_facts:=null; new.build_cursor:=null; end if;
  return new;
end $$;
create trigger clear_matching_profile before update on public.account_match_state
  for each row execute function public.clear_matching_profile();
revoke all on function public.save_account_match_profile(uuid,uuid,jsonb),public.clear_matching_profile() from public,anon,authenticated;
grant execute on function public.save_account_match_profile(uuid,uuid,jsonb) to service_role;
