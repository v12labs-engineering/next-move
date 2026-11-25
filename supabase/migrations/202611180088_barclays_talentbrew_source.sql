-- Register the reviewed Barclays public HTML reader. Activation is separate.
alter table public.job_source_directory drop constraint job_source_directory_kind_check;
alter table public.job_source_directory add constraint job_source_directory_kind_check
  check (kind in ('ashby','greenhouse','lever','arbeitnow','smartrecruiters','workday','linkedin','recruitee','workable','alexandria','amazon','infopark','oracle','keka','zohorecruit','teamtailor','personio','adzuna','jobtech','accenture','eightfold','ibm','successfactors','talentbrew'));
alter table public.job_source_directory add constraint job_source_directory_talentbrew_scope check (
  kind <> 'talentbrew' or (id='talentbrew:barclays-india' and board='barclays-india' and company='Barclays' and config='{}'::jsonb)
);
do $$
declare definition text; updated text;
begin
  definition := pg_get_functiondef('public.job_search_source_pool(uuid,text[])'::regprocedure);
  updated := replace(definition, '''ibm'',''successfactors'')', '''ibm'',''successfactors'',''talentbrew'')');
  if updated = definition then raise exception 'Unexpected source pool definition; review before migration'; end if;
  execute updated;
end $$;
