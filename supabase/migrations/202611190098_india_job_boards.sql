-- Public multi-employer boards read rolling windows. Their collection and
-- application attribution are separate from employer ATS inventories.
alter table public.job_source_directory drop constraint job_source_directory_kind_check;
alter table public.job_source_directory add constraint job_source_directory_kind_check
  check (kind in ('ashby','greenhouse','lever','arbeitnow','smartrecruiters','workday','linkedin','recruitee','workable','alexandria','amazon','infopark','oracle','keka','zohorecruit','teamtailor','personio','adzuna','jobtech','accenture','eightfold','ibm','successfactors','talentbrew','indiaboard'));
alter table public.job_source_directory add constraint job_source_directory_india_board_scope check (
  kind <> 'indiaboard' or (board is not null and id = 'indiaboard:' || board
    and config = '{}'::jsonb and countries @> array['India'])
);

create or replace function public.catalog_source_is_india(p_source text) returns boolean
language sql stable security invoker set search_path='' as $$
  select exists(select 1 from public.job_catalog where source=p_source and country='India')
    or exists(select 1 from public.source_candidates where id=p_source and status='activated'
      and validation->'countries' ? 'India')
    or exists(select 1 from public.catalog_source_tasks where source_id=p_source and priority='india')
    or exists(select 1 from public.job_source_directory where id=p_source and kind='indiaboard'
      and countries @> array['India']);
$$;

do $$
declare target regprocedure; definition text; updated text;
begin
  target:='public.finish_catalog_run_without_capacity(uuid,uuid)'::regprocedure;
  definition:=pg_get_functiondef(target);
  updated:=replace(definition, '''adzuna'',''jobtech'') then', '''adzuna'',''jobtech'',''indiaboard'') then');
  if updated=definition then raise exception 'Unexpected windowed catalog publication definition'; end if;
  execute updated;

  -- Preserve publisher-specific polling intervals for the new board sources.
  target:='public.catalog_scheduled_due()'::regprocedure;
  definition:=pg_get_functiondef(target);
  updated:=replace(definition, 'when policy.india then least', 'when policy.india and d.kind<>''indiaboard'' then least');
  if updated=definition then raise exception 'Unexpected catalog scheduling definition'; end if;
  execute updated;

  target:='public.admit_catalog_scheduled_tasks(integer)'::regprocedure;
  definition:=pg_get_functiondef(target);
  updated:=replace(definition, 'where id=candidate.source_id;', 'where id=candidate.source_id and kind<>''indiaboard'';');
  if updated=definition then raise exception 'Unexpected catalog admission definition'; end if;
  execute updated;
end $$;
