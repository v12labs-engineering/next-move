-- Add two documented public ATS feeds; no source is activated by this migration.
alter table public.source_candidates drop constraint source_candidates_kind_check;
alter table public.source_candidates add constraint source_candidates_kind_check check(kind in ('ashby','greenhouse','lever','smartrecruiters','workday','recruitee','workable'));
alter table public.job_source_directory drop constraint job_source_directory_kind_check;
alter table public.job_source_directory add constraint job_source_directory_kind_check check(kind in ('ashby','greenhouse','lever','arbeitnow','smartrecruiters','workday','linkedin','recruitee','workable'));
alter table public.source_candidates add constraint source_candidates_public_ats_board check(kind not in ('recruitee','workable') or board ~ '^[a-z0-9][a-z0-9-]{0,62}$');
alter table public.job_source_directory add constraint job_source_directory_public_ats_board check(kind not in ('recruitee','workable') or board ~ '^[a-z0-9][a-z0-9-]{0,62}$');

-- Preserve the installed search function, including optional LinkedIn/config
-- support. Some staging installations deliberately have not enabled LinkedIn.
do $$
declare definition text; updated text;
begin
 definition:=pg_get_functiondef('public.job_search_source_pool(uuid,text[])'::regprocedure);
 updated:=replace(definition,
  'd.kind in (''ashby'',''greenhouse'',''lever'',''smartrecruiters'',''workday'',''linkedin'')',
  'd.kind in (''ashby'',''greenhouse'',''lever'',''smartrecruiters'',''workday'',''linkedin'',''recruitee'',''workable'')');
 if updated=definition then
  updated:=replace(definition,
   'd.kind in (''ashby'',''greenhouse'',''lever'',''smartrecruiters'',''workday'')',
   'd.kind in (''ashby'',''greenhouse'',''lever'',''smartrecruiters'',''workday'',''recruitee'',''workable'')');
 end if;
 if updated=definition then raise exception 'Unexpected source pool definition; review before migration'; end if;
 execute updated;
end $$;
