-- Auto-apply is the candidate's continuing instruction for this application.
-- Answer edits invalidate the frozen packet, not that instruction. Only a
-- complete, never-sent, ready revision can be frozen again by the service.
create or replace function public.queue_automatic_application(p_id uuid,p_revision integer) returns boolean
language plpgsql security definer set search_path='' as $$
declare r public.application_runs; owner_id uuid;
begin
  select user_id into owner_id from public.application_runs where id=p_id;
  if not found then return false; end if;
  perform 1 from public.account_profiles where user_id=owner_id for update;
  select * into r from public.application_runs where id=p_id for update;
  if r.revision<>p_revision or r.status<>'ready' or not r.automatic
    or r.packet is null or r.receipt is not null
    or exists(select 1 from public.application_events where application_id=r.id
      and status in ('submitting','submitted','submission_unknown')) then return false; end if;
  if jsonb_typeof(r.packet->'fields') is distinct from 'array'
    or jsonb_typeof(r.packet->'answers') is distinct from 'object'
    or length(coalesce(r.packet->>'resume','')) not between 30 and 50000
    or exists(select 1 from jsonb_array_elements(r.packet->'fields') f
      group by f->>'id' having count(*)>1)
    or exists(select 1 from jsonb_array_elements(r.packet->'fields') f
      where f->>'kind'<>'resume' and
        (coalesce((f->>'required')::boolean,false) or
          not public.application_answer_blank(r.packet->'answers'->(f->>'id')))
        and not public.application_answer_valid(f,r.packet->'answers'->(f->>'id')))
    then return false; end if;
  update public.application_runs set status='queued',approved_packet=packet,
    approved_revision=revision,approved_at=now(),updated_at=now(),message=''
    where id=r.id;
  return true;
end $$;
revoke all on function public.queue_automatic_application(uuid,integer) from public,anon,authenticated;
grant execute on function public.queue_automatic_application(uuid,integer) to service_role;
