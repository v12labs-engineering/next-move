-- Candidate-owned question history and explicitly approved answer reuse.
-- No answer is learned from page defaults, model suggestions or another account.
create function public.application_answer_blank(p_answer jsonb) returns boolean
language sql immutable set search_path='' as $$
 select p_answer is null or p_answer='null'::jsonb or p_answer='[]'::jsonb
   or (jsonb_typeof(p_answer)='string' and btrim(p_answer#>>'{}')='')
$$;
create function public.application_question_key(p_field jsonb) returns text
language sql immutable set search_path='' as $$
 select md5(jsonb_build_object(
  'label',regexp_replace(lower(btrim(p_field->>'label')),'\s+',' ','g'),
  'help',regexp_replace(lower(btrim(coalesce(p_field->>'help',''))),'\s+',' ','g'),
  'kind',p_field->>'kind','options',coalesce(p_field->'options','[]'::jsonb)
 )::text)
$$;
create function public.application_answer_valid(p_field jsonb,p_answer jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare v text; n integer:=0; begin
 if p_field->>'kind' in ('resume','unsupported') or public.application_answer_blank(p_answer) then return false; end if;
 if jsonb_typeof(p_answer) not in ('string','array') or octet_length(p_answer::text)>15000 then return false; end if;
 if jsonb_typeof(p_answer)='array' and exists(select 1 from jsonb_array_elements(p_answer) a where jsonb_typeof(a)<>'string') then return false; end if;
 for v in select value from jsonb_array_elements_text(case when jsonb_typeof(p_answer)='array' then p_answer else jsonb_build_array(p_answer) end) loop
  n:=n+1;
  if btrim(v)='' or length(v)>5000 then return false; end if;
  if jsonb_array_length(coalesce(p_field->'options','[]'::jsonb))>0 and not (p_field->'options') ? v then return false; end if;
  if p_field->>'kind'='email' and v !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' then return false; end if;
  if p_field->>'kind'='url' and v !~ '^https?://[^[:space:]]+$' then return false; end if;
  if p_field->>'kind'='number' and v !~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)([eE][+-]?[0-9]+)?$' then return false; end if;
 end loop;
 return n>0 and (p_field->>'kind'='checkbox' or n=1);
end $$;
create function public.application_question_reusable(p_field jsonb) returns boolean
language sql immutable set search_path='' as $$
 select p_field->>'kind' not in ('resume','unsupported') and
 concat_ws(' ',p_field->>'label',p_field->>'help',(p_field->'options')::text) !~* 'consent|agree|terms|privacy|certify|declare|attest|accuracy|acknowledg|datenschutz|bedingungen'
$$;

create table public.account_application_questions (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 question_key text not null,
 employer_key text not null,
 country text not null default '',
 company text not null,
 question jsonb not null check(jsonb_typeof(question)='object' and octet_length(question::text)<=20000),
 answer jsonb,
 reuse_scope text not null default 'never' check(reuse_scope in ('never','employer','all')),
 source_application_id uuid references public.application_runs(id) on delete set null,
 first_seen_at timestamptz not null default now(),
 last_seen_at timestamptz not null default now(),
 answered_at timestamptz,
 unique(user_id,question_key,employer_key,country),
 check(answer is null or public.application_answer_valid(question,answer)),
 check(reuse_scope='never' or answer is not null)
);
create unique index application_question_global_answer on public.account_application_questions(user_id,question_key,country) where reuse_scope='all';
create index application_question_owner on public.account_application_questions(user_id,last_seen_at desc);
alter table public.account_application_questions enable row level security;
revoke all on public.account_application_questions from public,anon,authenticated;
grant select,delete on public.account_application_questions to authenticated;
grant all on public.account_application_questions to service_role;
create policy question_owner_read on public.account_application_questions for select to authenticated using ((select auth.uid())=user_id);
create policy question_owner_forget on public.account_application_questions for delete to authenticated using ((select auth.uid())=user_id);

create function public.capture_application_questions() returns trigger language plpgsql security definer set search_path='' as $$
declare f jsonb; k text; employer text; destination text; begin
 if new.packet is null then return new; end if;
 employer:=coalesce(nullif(new.employer_key,''),lower(btrim(new.packet->>'company')),split_part(new.target_url,'/',3));
 select coalesce(j.country,'') into destination from public.job_catalog j where j.id=new.job_id;
 for f in select value from jsonb_array_elements(new.packet->'fields') loop
  if f->>'kind'='resume' then continue; end if;
  k:=public.application_question_key(f);
  if not public.application_answer_blank(new.packet->'answers'->(f->>'id')) and not exists(
   select 1 from public.account_application_questions q where q.user_id=new.user_id and q.question_key=k and q.employer_key=employer and q.country=coalesce(destination,'')
  ) then continue; end if;
  insert into public.account_application_questions(user_id,question_key,employer_key,country,company,question,source_application_id)
   values(new.user_id,k,employer,coalesce(destination,''),new.packet->>'company',f,new.id)
   on conflict(user_id,question_key,employer_key,country) do update set last_seen_at=now(),source_application_id=excluded.source_application_id;
 end loop;
 return new;
end $$;
create trigger application_question_capture after insert or update of packet on public.application_runs
 for each row execute function public.capture_application_questions();

-- Read only explicitly reusable, compatible answers for this run and destination.
-- Workers pass newly observed conditional fields before deciding whether to pause.
create function public.read_application_question_memory(p_id uuid,p_fields jsonb)
returns setof public.account_application_questions language sql stable security definer set search_path='' as $$
 select q.* from public.application_runs r
 left join public.job_catalog j on j.id=r.job_id
 join public.account_application_questions q on q.user_id=r.user_id and q.country=coalesce(j.country,'')
 where r.id=p_id and q.answer is not null and public.application_question_reusable(q.question) and
  (q.reuse_scope='all' or (q.reuse_scope='employer' and q.employer_key=coalesce(nullif(r.employer_key,''),lower(btrim(r.packet->>'company')),split_part(r.target_url,'/',3))))
 and q.question_key in (select public.application_question_key(f) from jsonb_array_elements(p_fields) f)
 order by (q.reuse_scope='employer') desc,q.answered_at desc
$$;

-- Saving the current review, its reuse choices and optional continuation is one
-- transaction. A stale revision cannot accidentally teach the answer library.
create function public.save_application_review(p_id uuid,p_revision integer,p_answers jsonb,p_resume text,p_remember jsonb,p_continue boolean)
returns integer language plpgsql security definer set search_path='' as $$
declare r public.application_runs; entry record; f jsonb; k text; employer text; destination text; v integer; choice text; begin
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
  select reuse_scope into choice from public.account_application_questions where user_id=auth.uid() and question_key=k and employer_key=employer and country=coalesce(destination,'');
  if not found and not (p_remember ? (f->>'id')) then continue; end if;
  if not public.application_answer_valid(f,p_answers->(f->>'id')) then continue; end if;
  choice:=coalesce(p_remember->>(f->>'id'),choice,'never');
  if choice='all' then
   update public.account_application_questions set reuse_scope='never' where user_id=auth.uid() and question_key=k and country=coalesce(destination,'') and reuse_scope='all';
  end if;
  insert into public.account_application_questions(user_id,question_key,employer_key,country,company,question,answer,reuse_scope,source_application_id,answered_at)
   values(auth.uid(),k,employer,coalesce(destination,''),r.packet->>'company',f,p_answers->(f->>'id'),choice,p_id,now())
   on conflict(user_id,question_key,employer_key,country) do update set answer=excluded.answer,reuse_scope=excluded.reuse_scope,answered_at=now(),last_seen_at=now(),source_application_id=p_id;
 end loop;
 if p_continue and not public.approve_application(p_id,v) then raise exception 'Application changed'; end if;
 return v;
end $$;

create function public.update_application_question(p_id uuid,p_answer jsonb,p_scope text) returns boolean
language plpgsql security definer set search_path='' as $$
declare q public.account_application_questions; begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 perform 1 from public.account_profiles where user_id=auth.uid() for update;
 select * into q from public.account_application_questions where id=p_id and user_id=auth.uid() for update;
 if not found then return false; end if;
 if p_scope not in ('never','employer','all') or not public.application_answer_valid(q.question,p_answer) then raise exception 'Invalid saved answer'; end if;
 if p_scope<>'never' and not public.application_question_reusable(q.question) then raise exception 'Confirm consent for each application'; end if;
 if p_scope='all' then update public.account_application_questions set reuse_scope='never' where user_id=auth.uid() and question_key=q.question_key and country=q.country and reuse_scope='all'; end if;
 update public.account_application_questions set answer=p_answer,reuse_scope=p_scope,answered_at=now() where id=q.id;
 return true;
end $$;

-- Alerts are derived from durable current packets, so refreshes/restarts cannot
-- lose them and resolved/cancelled applications disappear without stale notices.
create function public.application_question_alerts() returns jsonb
language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(alert order by updated_at desc),'[]'::jsonb) from (
  select r.updated_at,jsonb_build_object('applicationId',r.id,'revision',r.revision,
   'title',r.packet->>'title','company',r.packet->>'company','questions',questions.value) alert
  from public.application_runs r
  cross join lateral (select jsonb_agg(jsonb_build_object('id',f->>'id','label',f->>'label','unsupported',f->>'kind'='unsupported')) value
   from jsonb_array_elements(r.packet->'fields') f where (f->>'required')::boolean and f->>'kind'<>'resume'
   and (f->>'kind'='unsupported' or not public.application_answer_valid(f,r.packet->'answers'->(f->>'id')))) questions
  where r.user_id=auth.uid() and r.status in ('ready','needs_attention') and questions.value is not null
 ) pending
$$;

revoke all on function public.application_answer_blank(jsonb),public.application_question_key(jsonb),public.application_answer_valid(jsonb,jsonb),public.application_question_reusable(jsonb),public.capture_application_questions(),public.read_application_question_memory(uuid,jsonb),public.save_application_review(uuid,integer,jsonb,text,jsonb,boolean),public.update_application_question(uuid,jsonb,text),public.application_question_alerts() from public,anon,authenticated;
grant execute on function public.application_answer_blank(jsonb),public.application_answer_valid(jsonb,jsonb) to authenticated,service_role;
grant execute on function public.read_application_question_memory(uuid,jsonb) to service_role;
grant execute on function public.save_application_review(uuid,integer,jsonb,text,jsonb,boolean),public.update_application_question(uuid,jsonb,text),public.application_question_alerts() to authenticated;

-- Existing unanswered questions become visible in the library without changing
-- application revisions, approval, status or submission history.
insert into public.account_application_questions(user_id,question_key,employer_key,country,company,question,source_application_id,first_seen_at,last_seen_at)
 select r.user_id,public.application_question_key(f),coalesce(nullif(r.employer_key,''),lower(btrim(r.packet->>'company')),split_part(r.target_url,'/',3)),coalesce(j.country,''),r.packet->>'company',f,r.id,r.created_at,r.updated_at
 from public.application_runs r left join public.job_catalog j on j.id=r.job_id
 cross join lateral jsonb_array_elements(r.packet->'fields') f
 where f->>'kind'<>'resume' and public.application_answer_blank(r.packet->'answers'->(f->>'id'))
 order by r.updated_at desc on conflict(user_id,question_key,employer_key,country) do nothing;
