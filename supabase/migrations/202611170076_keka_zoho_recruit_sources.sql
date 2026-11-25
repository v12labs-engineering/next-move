alter table public.job_source_directory drop constraint job_source_directory_kind_check;
alter table public.job_source_directory add constraint job_source_directory_kind_check
  check (kind in ('ashby','greenhouse','lever','arbeitnow','smartrecruiters','workday','linkedin','recruitee','workable','alexandria','amazon','infopark','oracle','keka','zohorecruit'));
alter table public.source_candidates drop constraint source_candidates_kind_check;
alter table public.source_candidates add constraint source_candidates_kind_check
  check (kind in ('ashby','greenhouse','lever','smartrecruiters','workday','recruitee','workable','keka','zohorecruit'));
alter table public.source_candidates add constraint source_candidates_keka_zoho_board check(
  (kind <> 'keka' or board ~ '^[a-z0-9][a-z0-9-]{0,62}$') and
  (kind <> 'zohorecruit' or board ~ '^[a-z0-9][a-z0-9-]{0,62}\.zohorecruit\.(com|in|eu|com\.au|jp)$'));
alter table public.job_source_directory add constraint job_source_directory_keka_zoho_board check(
  (kind <> 'keka' or board ~ '^[a-z0-9][a-z0-9-]{0,62}$') and
  (kind <> 'zohorecruit' or board ~ '^[a-z0-9][a-z0-9-]{0,62}\.zohorecruit\.(com|in|eu|com\.au|jp)$'));

do $$
declare definition text; updated text;
begin
 definition:=pg_get_functiondef('public.job_search_source_pool(uuid,text[])'::regprocedure);
 updated:=replace(definition,
  '''recruitee'',''workable'')',
  '''recruitee'',''workable'',''keka'',''zohorecruit'')');
 if updated=definition then raise exception 'Unexpected source pool definition; review before migration'; end if;
 execute updated;
end $$;
