-- Register the public Deloitte India inventory; activation is a measured rollout.
alter table public.job_source_directory drop constraint job_source_directory_kind_check;
alter table public.job_source_directory add constraint job_source_directory_kind_check
  check (kind in ('ashby','greenhouse','lever','arbeitnow','smartrecruiters','workday','linkedin','recruitee','workable','alexandria','amazon','infopark','oracle','keka','zohorecruit','teamtailor','personio','adzuna','jobtech','accenture','eightfold','ibm','successfactors'));
alter table public.job_source_directory add constraint job_source_directory_successfactors_scope check (
  kind <> 'successfactors' or (id='successfactors:deloitte-india' and board='deloitte-india' and company='Deloitte' and config='{}'::jsonb)
);
do $$
declare definition text; updated text;
begin
  definition := pg_get_functiondef('public.job_search_source_pool(uuid,text[])'::regprocedure);
  updated := replace(definition, '''accenture'',''ibm'')', '''accenture'',''ibm'',''successfactors'')');
  if updated = definition then raise exception 'Unexpected source pool definition; review before migration'; end if;
  execute updated;
end $$;
