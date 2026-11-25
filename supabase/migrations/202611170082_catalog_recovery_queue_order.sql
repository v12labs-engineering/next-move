-- Keep the original source-task age when a crash or bounded continuation
-- creates a new outbox generation. Recovery must not move an older source
-- behind every newer admission. Capacity remains four total, one background.
create or replace function public.claim_catalog_scheduled_outbox(p_limit integer default 4) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare candidate record; intent public.catalog_task_outbox; result jsonb:='[]'::jsonb;
  occupied integer; backgrounds integer;
begin
  if p_limit is null or p_limit not between 1 and 4 then raise exception 'Invalid scheduled dispatch limit'; end if;
  perform pg_catalog.pg_advisory_xact_lock(730112039);
  select count(*),count(*) filter(where t.priority='background') into occupied,backgrounds
  from public.catalog_source_tasks t where
    (t.state='running' and t.lease_until>now()) or
    (t.state in ('pending','waiting') and t.not_before<=now() and exists(
      select 1 from public.catalog_task_outbox o where o.task_id=t.id and o.dispatch_generation=t.dispatch_generation
      and (o.lease_until>now() or o.sent_at>now()-interval '5 minutes')));
  for candidate in
    select o.id,t.source_id,t.priority from public.catalog_task_outbox o
    join public.catalog_source_tasks t on t.id=o.task_id
    where o.sent_at is null and o.available_at<=now() and (o.lease_until is null or o.lease_until<=now())
      and t.dispatch_generation=o.dispatch_generation and t.state in ('pending','waiting') and t.not_before<=now()
    order by case when t.priority='india' then 0 else 1 end,t.created_at,o.available_at,o.id
    for update of o skip locked
  loop
    exit when occupied>=4 or jsonb_array_length(result)>=p_limit;
    if candidate.priority='background' and backgrounds>=1 then continue; end if;
    update public.catalog_task_outbox set lease_token=gen_random_uuid(),lease_until=now()+interval '2 minutes'
      where id=candidate.id returning * into intent;
    result:=result||jsonb_build_array(to_jsonb(intent)||jsonb_build_object('source_id',candidate.source_id,'priority',candidate.priority));
    occupied:=occupied+1;
    if candidate.priority='background' then backgrounds:=backgrounds+1; end if;
  end loop;
  return result;
end $$;

revoke all on function public.claim_catalog_scheduled_outbox(integer) from public,anon,authenticated;
grant execute on function public.claim_catalog_scheduled_outbox(integer) to service_role;
