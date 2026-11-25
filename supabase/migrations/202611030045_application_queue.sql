-- One account processes one application at a time, across preparation and send.
-- Existing pending work keeps its original order; resumed reviews join the tail.
alter table public.application_runs add column queue_entered_at timestamptz not null default clock_timestamp();
update public.application_runs set queue_entered_at=created_at;
create index application_runs_queue on public.application_runs(user_id,queue_entered_at,id)
  where status in ('queued_prepare','preparing','ready','queued','running','submitting');

create function public.application_queue_order() returns trigger language plpgsql set search_path='' as $$
begin
  if new.status='ready' and old.status='ready' and old.auto_submit_requested_at is null
    and new.auto_submit_requested_at is not null then
    new.queue_entered_at:=clock_timestamp();
  elsif new.status in ('queued_prepare','queued') and
    (old.status in ('needs_attention','cancelled') or
     (old.status='ready' and (old.auto_submit_requested_at is null or new.revision<>old.revision))) then
    new.queue_entered_at:=clock_timestamp();
  end if;
  return new;
end $$;
revoke all on function public.application_queue_order() from public,anon,authenticated;
create trigger application_queue_order before update on public.application_runs
  for each row execute function public.application_queue_order();

-- Called under the account lock by both worker claim functions. A prepared
-- automatic packet holds its place until it is queued or pauses for answers.
create function public.application_queue_turn(p_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.application_runs r where r.id=p_id
    and not exists(select 1 from public.application_runs a
      where a.user_id=r.user_id and a.id<>r.id and
        (a.status in ('preparing','running','submitting') or
         ((a.status in ('queued_prepare','queued') or
           (a.status='ready' and a.auto_submit_requested_at is not null))
          and (a.queue_entered_at,a.id)<(r.queue_entered_at,r.id)))))
$$;
revoke all on function public.application_queue_turn(uuid) from public,anon,authenticated;
grant execute on function public.application_queue_turn(uuid) to service_role;

create or replace function public.claim_application_preparation(p_id uuid,p_token uuid) returns setof public.application_runs
language plpgsql security definer set search_path='' as $$
declare owner_id uuid;
begin
  select user_id into owner_id from public.application_runs where id=p_id;
  if not found or p_token is null then return; end if;
  perform 1 from public.account_profiles where user_id=owner_id for update;
  return query update public.application_runs r set status='preparing',preparation_token=p_token,started_at=now(),updated_at=now()
    where r.id=p_id and r.status='queued_prepare' and public.application_queue_turn(r.id)
    and not exists(select 1 from public.application_tasks t where t.application_id=r.id and t.revision=r.revision and t.next_retry_at>now())
    returning r.*;
end $$;

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
  -- Waiting in the queue does not consume the approval's freshness window.
  if r.approved_at is null or r.approved_at<r.queue_entered_at-interval '30 minutes' or exists(
    select 1 from public.application_runs a where a.user_id=r.user_id and a.id<>r.id
      and coalesce(a.employer_key,split_part(a.target_url,'/',3))=employer
      and (a.status in ('running','submitting','submission_unknown') or
        (employer='n8n' and a.status='submitted' and a.updated_at>now()-interval '15 days'))
  ) then
    update public.application_runs set status='needs_attention',message='Another application to this employer has an uncertain result, is inside the employer cooldown, or needs renewed approval. Review before continuing.',updated_at=now() where id=r.id;
    return;
  end if;
  return query update public.application_runs set status='running',started_at=now(),updated_at=now() where id=r.id returning *;
end $$;

-- Initial authorization remains valid while queued. After preparation starts,
-- the existing bounded preparation window and revision invalidation still apply.
create or replace function public.queue_automatic_application(p_id uuid,p_revision integer) returns boolean
language plpgsql security definer set search_path='' as $$
begin
  update public.application_runs set status='queued',approved_packet=packet,approved_revision=revision,approved_at=now(),updated_at=now()
    where id=p_id and revision=p_revision and status='ready' and packet is not null
      and auto_submit_requested_at is not null and started_at>now()-interval '30 minutes';
  return found;
end $$;
