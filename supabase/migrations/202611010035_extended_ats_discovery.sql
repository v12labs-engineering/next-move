-- More source readers; no sources are enabled and no jobs are inserted here.
alter table public.source_candidates drop constraint source_candidates_kind_check;
alter table public.source_candidates add constraint source_candidates_kind_check check(kind in ('ashby','greenhouse','lever','smartrecruiters','workday'));
alter table public.source_candidates drop constraint source_candidates_board_check;
alter table public.source_candidates add constraint source_candidates_board_check check(
 (kind<>'workday' and board ~ '^[a-z0-9][a-z0-9._-]{0,99}$') or
 (kind='workday' and board ~ '^[a-z0-9][a-z0-9-]{0,62}\.wd[0-9]{1,2}\.myworkdayjobs\.com~[A-Za-z0-9][A-Za-z0-9_-]{0,99}$'));
alter table public.job_source_directory drop constraint job_source_directory_kind_check;
alter table public.job_source_directory add constraint job_source_directory_kind_check check(kind in ('ashby','greenhouse','lever','arbeitnow','smartrecruiters','workday'));
alter table public.job_source_directory drop constraint job_source_directory_check;
alter table public.job_source_directory add constraint job_source_directory_check check(
 (kind='arbeitnow' and board is null and id='arbeitnow') or
 (kind<>'arbeitnow' and board is not null and id=kind||':'||board and (
   (kind<>'workday' and board ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$') or
   (kind='workday' and board ~ '^[a-z0-9][a-z0-9-]{0,62}\.wd[0-9]{1,2}\.myworkdayjobs\.com~[A-Za-z0-9][A-Za-z0-9_-]{0,99}$'))));
