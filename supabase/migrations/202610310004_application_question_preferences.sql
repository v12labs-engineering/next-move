-- Distinguish a question that has not received a reuse choice from an explicit
-- per-employer Ask again override. Existing approved reuse choices remain valid.
alter table public.account_application_questions add column reuse_explicit boolean not null default false;
update public.account_application_questions set reuse_explicit=true where reuse_scope<>'never';

create or replace function public.read_application_question_memory(p_id uuid,p_fields jsonb)
returns setof public.account_application_questions language sql stable security definer set search_path='' as $$
 select q.* from public.application_runs r
 left join public.job_catalog j on j.id=r.job_id
 join public.account_application_questions q on q.user_id=r.user_id and q.country=coalesce(j.country,'')
 where r.id=p_id and q.answer is not null and public.application_question_reusable(q.question) and
  ((q.reuse_scope='all' and not exists(select 1 from public.account_application_questions local_choice where local_choice.user_id=r.user_id and local_choice.question_key=q.question_key and local_choice.country=q.country and local_choice.employer_key=coalesce(nullif(r.employer_key,''),lower(btrim(r.packet->>'company')),split_part(r.target_url,'/',3)) and local_choice.reuse_scope='never' and local_choice.reuse_explicit)) or (q.reuse_scope='employer' and q.employer_key=coalesce(nullif(r.employer_key,''),lower(btrim(r.packet->>'company')),split_part(r.target_url,'/',3))))
 and q.question_key in (select public.application_question_key(f) from jsonb_array_elements(p_fields) f)
 order by (q.reuse_scope='employer') desc,q.answered_at desc
$$;

create or replace function public.save_application_review(p_id uuid,p_revision integer,p_answers jsonb,p_resume text,p_remember jsonb,p_continue boolean)
returns integer language plpgsql security definer set search_path='' as $$
declare r public.application_runs; entry record; f jsonb; k text; employer text; destination text; v integer; choice text; chosen boolean; begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 perform 1 from public.account_profiles where user_id=auth.uid() for update;
 select * into r from public.application_runs where id=p_id and user_id=auth.uid() for update;
 if not found or r.revision<>p_revision or r.status not in ('ready','queued','needs_attention') or r.packet is null then raise exception 'Application changed; reload before editing' using errcode='P0001'; end if;
 if jsonb_typeof(p_remember)<>'object' or octet_length(p_remember::text)>40000 then raise exception 'Invalid reuse choices'; end if;
 employer:=coalesce(nullif(r.employer_key,''),lower(btrim(r.packet->>'company')),split_part(r.target_url,'/',3));
 select coalesce(j.country,'') into destination from public.job_catalog j where j.id=r.job_id;
 for entry in select key,value from jsonb_each_text(p_remember) loop
  select value into f from jsonb_array_elements(r.packet->'fields') where value->>'id'=entry.key;
  if f is null or entry.value not in ('never','employer','all') or not public.application_answer_valid(f,p_answers->entry.key) then raise exception 'Invalid saved answer'; end if;
  if entry.value<>'never' and not public.application_question_reusable(f) then raise exception 'Confirm consent for each application'; end if;
 end loop;
 v:=public.edit_application(p_id,p_revision,p_answers,p_resume);
 for f in select value from jsonb_array_elements(r.packet->'fields') loop
  k:=public.application_question_key(f);
  select reuse_scope,reuse_explicit into choice,chosen from public.account_application_questions where user_id=auth.uid() and question_key=k and employer_key=employer and country=coalesce(destination,'');
  if not found and not (p_remember ? (f->>'id')) then continue; end if;
  if not public.application_answer_valid(f,p_answers->(f->>'id')) then continue; end if;
  choice:=coalesce(p_remember->>(f->>'id'),choice,'never');
  chosen:=(p_remember ? (f->>'id')) or coalesce(chosen,false);
  if choice='all' then
   update public.account_application_questions set reuse_scope='never',reuse_explicit=false where user_id=auth.uid() and question_key=k and country=coalesce(destination,'') and reuse_scope='all';
  end if;
  insert into public.account_application_questions(user_id,question_key,employer_key,country,company,question,answer,reuse_scope,reuse_explicit,source_application_id,answered_at)
   values(auth.uid(),k,employer,coalesce(destination,''),r.packet->>'company',f,p_answers->(f->>'id'),choice,chosen,p_id,now())
   on conflict(user_id,question_key,employer_key,country) do update set answer=excluded.answer,reuse_scope=excluded.reuse_scope,reuse_explicit=excluded.reuse_explicit,answered_at=now(),last_seen_at=now(),source_application_id=p_id;
 end loop;
 if p_continue and not public.approve_application(p_id,v) then raise exception 'Application changed'; end if;
 return v;
end $$;

create or replace function public.update_application_question(p_id uuid,p_answer jsonb,p_scope text) returns boolean
language plpgsql security definer set search_path='' as $$
declare q public.account_application_questions; begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 perform 1 from public.account_profiles where user_id=auth.uid() for update;
 select * into q from public.account_application_questions where id=p_id and user_id=auth.uid() for update;
 if not found then return false; end if;
 if p_scope not in ('never','employer','all') or not public.application_answer_valid(q.question,p_answer) then raise exception 'Invalid saved answer'; end if;
 if p_scope<>'never' and not public.application_question_reusable(q.question) then raise exception 'Confirm consent for each application'; end if;
 if p_scope='all' then update public.account_application_questions set reuse_scope='never',reuse_explicit=false where user_id=auth.uid() and question_key=q.question_key and country=q.country and reuse_scope='all'; end if;
 update public.account_application_questions set answer=p_answer,reuse_scope=p_scope,reuse_explicit=true,answered_at=now() where id=q.id;
 return true;
end $$;
