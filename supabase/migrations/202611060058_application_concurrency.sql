-- Two account slots across preparation and submission. Both claim functions
-- already serialize under the account profile lock, so duplicate dispatches
-- cannot overbook. Retry cooldowns and prepared automatic handoffs retain their
-- existing queue semantics. Employer and exact-revision send guards are unchanged.
create or replace function public.application_queue_turn(p_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.application_runs r where r.id=p_id
    and (select count(*) from public.application_runs a
      where a.user_id=r.user_id and a.id<>r.id and
        (a.status in ('preparing','running','submitting') or
         ((a.status in ('queued_prepare','queued') or
           (a.status='ready' and a.auto_submit_requested_at is not null))
          and (a.retry_after is null or a.retry_after<=now())
          and not exists(select 1 from public.application_tasks t
            where t.application_id=a.id and t.revision=a.revision and t.next_retry_at>now())
          and (a.queue_entered_at,a.id)<(r.queue_entered_at,r.id)))) < 2)
$$;
