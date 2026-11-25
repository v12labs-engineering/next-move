-- Country-wide aggregator feeds: Adzuna (19 countries) and Arbetsförmedlingen
-- JobTech (Sweden). They read a recent window, so publication must not expire
-- unseen rows; the 30-day posted_at retention ages them out instead.
alter table public.job_source_directory drop constraint job_source_directory_kind_check;
alter table public.job_source_directory add constraint job_source_directory_kind_check
  check (kind in ('ashby','greenhouse','lever','arbeitnow','smartrecruiters','workday','linkedin','recruitee','workable','alexandria','amazon','infopark','oracle','keka','zohorecruit','teamtailor','personio','adzuna','jobtech','accenture'));
alter table public.job_source_directory add constraint job_source_directory_country_feed check (
  (kind <> 'adzuna' or board in ('at','au','be','br','ca','ch','de','es','fr','gb','in','it','mx','nl','nz','pl','sg','us','za')) and
  (kind <> 'jobtech' or board = 'se')
);

do $$
declare definition text; updated text;
begin
  definition:=pg_get_functiondef('public.finish_catalog_run_without_capacity(uuid,uuid)'::regprocedure);
  updated:=replace(definition,
    'if s.id<>''linkedin'' then',
    'if s.id<>''linkedin'' and split_part(s.id,'':'',1) not in (''adzuna'',''jobtech'') then');
  if updated=definition then raise exception 'Unexpected catalog publication definition; review before migration'; end if;
  execute updated;
end $$;

insert into public.job_source_directory(id,kind,company,board,enabled,collection_interval_seconds)
select 'adzuna:'||cc,'adzuna','Adzuna '||upper(cc),cc,true,43200
from unnest(array['at','au','be','br','ca','ch','de','es','fr','gb','in','it','mx','nl','nz','pl','sg','us','za']) cc
on conflict (id) do nothing;
insert into public.job_source_directory(id,kind,company,board,enabled,collection_interval_seconds)
values ('jobtech:se','jobtech','Arbetsförmedlingen','se',true,21600)
on conflict (id) do nothing;
