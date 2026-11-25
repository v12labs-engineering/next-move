-- Register the reviewed IBM public search reader. No source is activated here.
alter table public.job_source_directory drop constraint job_source_directory_kind_check;
alter table public.job_source_directory add constraint job_source_directory_kind_check
  check (kind in ('ashby','greenhouse','lever','arbeitnow','smartrecruiters','workday','linkedin','recruitee','workable','alexandria','amazon','infopark','oracle','keka','zohorecruit','teamtailor','personio','adzuna','jobtech','accenture','ibm'));

alter table public.job_source_directory add constraint job_source_directory_ibm_scope check (
  kind <> 'ibm' or (
    id = 'ibm:india' and board = 'india' and company = 'IBM' and config = '{}'::jsonb
  )
);

do $$
declare definition text; updated text;
begin
  definition := pg_get_functiondef('public.job_search_source_pool(uuid,text[])'::regprocedure);
  updated := replace(definition,
    '''amazon'',''oracle'',''accenture'')',
    '''amazon'',''oracle'',''accenture'',''ibm'')');
  if updated = definition then raise exception 'Unexpected source pool definition; review before migration'; end if;
  execute updated;
end $$;
