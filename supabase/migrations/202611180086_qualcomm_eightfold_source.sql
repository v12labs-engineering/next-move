-- Register the reviewed public Qualcomm feed. No source is activated here.
alter table public.job_source_directory drop constraint job_source_directory_kind_check;
alter table public.job_source_directory add constraint job_source_directory_kind_check
  check (kind in ('ashby','greenhouse','lever','arbeitnow','smartrecruiters','workday','linkedin','recruitee','workable','alexandria','amazon','infopark','oracle','keka','zohorecruit','teamtailor','personio','adzuna','jobtech','accenture','ibm','eightfold'));
alter table public.job_source_directory add constraint job_source_directory_eightfold_scope check (
  kind <> 'eightfold' or (
    id = 'eightfold:qualcomm-india' and board = 'qualcomm-india' and company = 'Qualcomm' and config = '{}'::jsonb
  )
);
do $$
declare definition text; updated text;
begin
  definition := pg_get_functiondef('public.job_search_source_pool(uuid,text[])'::regprocedure);
  updated := replace(definition,
    '''oracle'',''accenture'',''ibm'')',
    '''oracle'',''eightfold'',''accenture'',''ibm'')');
  if updated = definition then raise exception 'Unexpected source pool definition; review before migration'; end if;
  execute updated;
end $$;
