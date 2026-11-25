-- Return explicit employer-level Ask again choices to workers too. They still
-- suppress global memory, and now also suppress reusable-profile/model fills.
-- Keep the same service-only signature and return type; no new user grants.
create or replace function public.read_application_question_memory(p_id uuid,p_fields jsonb)
returns setof public.account_application_questions language sql stable security definer set search_path='' as $$
 select q.* from public.application_runs r
 left join public.job_catalog j on j.id=r.job_id
 join public.account_application_questions q on q.user_id=r.user_id and q.country=coalesce(j.country,'')
 where r.id=p_id and q.answer is not null and public.application_question_reusable(q.question)
 and q.question_key in (select public.application_question_key(f) from jsonb_array_elements(p_fields) f)
 and (
  (q.reuse_scope='never' and q.reuse_explicit and q.employer_key=coalesce(nullif(r.employer_key,''),lower(btrim(r.packet->>'company')),split_part(r.target_url,'/',3)))
  or (q.reuse_scope='employer' and q.employer_key=coalesce(nullif(r.employer_key,''),lower(btrim(r.packet->>'company')),split_part(r.target_url,'/',3)))
  or (q.reuse_scope='all' and not exists(
   select 1 from public.account_application_questions local_choice where local_choice.user_id=r.user_id
   and local_choice.question_key=q.question_key and local_choice.country=q.country
   and local_choice.employer_key=coalesce(nullif(r.employer_key,''),lower(btrim(r.packet->>'company')),split_part(r.target_url,'/',3))
   and local_choice.reuse_scope='never' and local_choice.reuse_explicit
  ))
 )
 order by (q.reuse_scope='never') desc,(q.reuse_scope='employer') desc,q.answered_at desc
$$;
revoke all on function public.read_application_question_memory(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.read_application_question_memory(uuid,jsonb) to service_role;
