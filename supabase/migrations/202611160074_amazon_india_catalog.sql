alter table public.job_source_directory drop constraint job_source_directory_kind_check;
alter table public.job_source_directory add constraint job_source_directory_kind_check
  check (kind in ('ashby','greenhouse','lever','arbeitnow','smartrecruiters','workday','linkedin','recruitee','workable','alexandria','amazon'));
alter table public.job_source_directory add constraint job_source_directory_amazon_scope
  check (kind <> 'amazon' or board = 'india-software');
