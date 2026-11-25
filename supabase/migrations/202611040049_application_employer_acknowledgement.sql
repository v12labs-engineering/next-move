-- A candidate can explicitly continue with a different catalog job after
-- reviewing one earlier uncertain result. This never retries the uncertain run.
create table public.application_employer_acknowledgements (
  application_id uuid not null references public.application_runs(id) on delete cascade,
  revision integer not null check (revision>0),
  conflicting_application_id uuid not null references public.application_runs(id),
  user_id uuid not null references auth.users(id),
  acknowledged_at timestamptz not null default now(),
  primary key(application_id,revision,conflicting_application_id),
  check(application_id<>conflicting_application_id)
);
alter table public.application_employer_acknowledgements enable row level security;
revoke all on public.application_employer_acknowledgements from public,anon,authenticated;
grant select on public.application_employer_acknowledgements to authenticated;
grant all on public.application_employer_acknowledgements to service_role;
create policy employer_acknowledgement_owner on public.application_employer_acknowledgements
  for select to authenticated using(user_id=(select auth.uid()));

create function public.acknowledge_employer_conflict(p_id uuid,p_revision integer,p_conflict_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare r public.application_runs; a public.application_runs; employer text;
begin
  if auth.uid() is null then raise exception 'Conflict acknowledgement not allowed'; end if;
  perform 1 from public.account_profiles where user_id=auth.uid() for update;
  select * into r from public.application_runs where id=p_id and user_id=auth.uid() for update;
  if not found or r.revision<>p_revision or r.status not in ('ready','needs_attention') or r.packet is null then
    raise exception 'Conflict acknowledgement not allowed';
  end if;
  select * into a from public.application_runs where id=p_conflict_id and user_id=auth.uid();
  employer:=coalesce(r.employer_key,split_part(r.target_url,'/',3));
  if not found or a.id=r.id or a.status<>'submission_unknown' or employer='n8n'
    or coalesce(a.employer_key,split_part(a.target_url,'/',3))<>employer
    or r.job_id is null or a.job_id is null or r.job_id=a.job_id or r.target_url=a.target_url then
    raise exception 'Conflict acknowledgement not allowed';
  end if;
  insert into public.application_employer_acknowledgements(application_id,revision,conflicting_application_id,user_id)
    values(r.id,r.revision,a.id,r.user_id)
    on conflict(application_id,revision,conflicting_application_id) do update set acknowledged_at=now();
  update public.application_runs set status='ready',message='You approved continuing with this different role despite an earlier uncertain application.',updated_at=now() where id=r.id;
  return true;
end $$;
revoke all on function public.acknowledge_employer_conflict(uuid,integer,uuid) from public,anon,authenticated;
grant execute on function public.acknowledge_employer_conflict(uuid,integer,uuid) to authenticated;

create or replace function public.claim_application(p_id uuid,p_revision integer) returns setof public.application_runs
language plpgsql security definer set search_path='' as $$
declare r public.application_runs; owner_id uuid; employer text;
begin
  select user_id into owner_id from public.application_runs where id=p_id;
  if not found then return; end if;
  perform 1 from public.account_profiles where user_id=owner_id for update;
  select * into r from public.application_runs where id=p_id for update;
  if not found or r.status<>'queued' or r.revision<>p_revision
    or r.approved_revision is distinct from p_revision or r.packet is distinct from r.approved_packet
    or not public.application_queue_turn(r.id) then return; end if;
  employer:=coalesce(r.employer_key,split_part(r.target_url,'/',3));
  if r.approved_at is null or r.approved_at<r.queue_entered_at-interval '30 minutes' or exists(
    select 1 from public.application_runs a where a.user_id=r.user_id and a.id<>r.id
      and coalesce(a.employer_key,split_part(a.target_url,'/',3))=employer
      and (a.status in ('running','submitting') or
        (a.status='submission_unknown' and not (
          employer<>'n8n' and r.job_id is not null and a.job_id is not null
          and r.job_id<>a.job_id and r.target_url<>a.target_url and exists(
            select 1 from public.application_employer_acknowledgements k
            where k.application_id=r.id and k.revision=r.revision
              and k.conflicting_application_id=a.id and k.user_id=r.user_id
              and k.acknowledged_at>now()-interval '30 minutes'
          )
        )) or
        (employer='n8n' and a.status='submitted' and a.updated_at>now()-interval '15 days'))
  ) then
    update public.application_runs set status='needs_attention',message='Another application to this employer has an uncertain result, is inside the employer cooldown, or needs renewed approval. Review before continuing.',updated_at=now() where id=r.id;
    return;
  end if;
  return query update public.application_runs set status='running',started_at=now(),updated_at=now() where id=r.id returning *;
end $$;
