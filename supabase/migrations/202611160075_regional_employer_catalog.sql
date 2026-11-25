alter table public.job_source_directory drop constraint job_source_directory_kind_check;
alter table public.job_source_directory add constraint job_source_directory_kind_check
  check (kind in ('ashby','greenhouse','lever','arbeitnow','smartrecruiters','workday','linkedin','recruitee','workable','alexandria','amazon','infopark','oracle'));
alter table public.job_source_directory add constraint job_source_directory_regional_scope check (
  (kind <> 'infopark' or board = 'kerala') and
  (kind <> 'oracle' or board in ('bny','ibs-software'))
);
