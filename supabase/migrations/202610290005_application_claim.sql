-- Serialize submissions for one candidate/employer, including concurrent roles.
create function public.claim_application(p_id uuid,p_revision integer) returns setof public.application_runs language plpgsql security definer set search_path='' as $$
declare r public.application_runs; v_board text; begin
 select * into r from public.application_runs where id=p_id for update;
 if not found or r.status<>'queued' or r.revision<>p_revision or r.approved_revision<>p_revision or r.packet<>r.approved_packet then return; end if;
 perform 1 from public.account_profiles where user_id=r.user_id for update;
 v_board:=split_part(r.target_url,'/',4);
 if r.approved_at<now()-interval '30 minutes' or exists(
   select 1 from public.application_runs a where a.user_id=r.user_id and a.id<>r.id
     and split_part(a.target_url,'/',4)=v_board
     and (a.status in ('running','submitting','submission_unknown') or
       (v_board='n8n' and a.status='submitted' and a.updated_at>now()-interval '15 days'))
 ) then
   update public.application_runs set status='needs_attention',message='Another application to this employer is running, has an uncertain result, or is inside the employer cooldown. Review before continuing.',updated_at=now() where id=r.id;
   return;
 end if;
 return query update public.application_runs set status='running',started_at=now(),updated_at=now() where id=r.id returning *;
end $$;
revoke all on function public.claim_application(uuid,integer) from public,anon,authenticated;
grant execute on function public.claim_application(uuid,integer) to service_role;
