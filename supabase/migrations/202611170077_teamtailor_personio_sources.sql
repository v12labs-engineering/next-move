-- Register platforms only. Candidate import, live validation and activation
-- remain separate; this migration does not enable or publish any source.
alter table public.job_source_directory drop constraint job_source_directory_kind_check;
alter table public.job_source_directory add constraint job_source_directory_kind_check
  check (kind in ('ashby','greenhouse','lever','arbeitnow','smartrecruiters','workday','linkedin','recruitee','workable','alexandria','amazon','infopark','oracle','keka','zohorecruit','teamtailor','personio'));
alter table public.source_candidates drop constraint source_candidates_kind_check;
alter table public.source_candidates add constraint source_candidates_kind_check
  check (kind in ('ashby','greenhouse','lever','smartrecruiters','workday','recruitee','workable','keka','zohorecruit','teamtailor','personio'));
alter table public.source_candidates add constraint source_candidates_xml_ats_board check (
  (kind <> 'teamtailor' or board ~ '^[a-z0-9][a-z0-9-]{0,62}\.teamtailor\.com$') and
  (kind <> 'personio' or board ~ '^[a-z0-9][a-z0-9-]{0,62}\.jobs\.personio\.(de|com)$') and
  (kind not in ('teamtailor','personio') or split_part(board,'.',1) not in ('www','api','app','cdn','help','login','docs'))
);
alter table public.job_source_directory add constraint job_source_directory_xml_ats_board check (
  (kind <> 'teamtailor' or board ~ '^[a-z0-9][a-z0-9-]{0,62}\.teamtailor\.com$') and
  (kind <> 'personio' or board ~ '^[a-z0-9][a-z0-9-]{0,62}\.jobs\.personio\.(de|com)$') and
  (kind not in ('teamtailor','personio') or split_part(board,'.',1) not in ('www','api','app','cdn','help','login','docs'))
);

-- Admit the same partitions in the durable archive queue as in the reader.
-- Automatic discovery still requires the existing staging-only application
-- flag; preserve its lease, provider backoff and global daily request budget.
alter table public.archive_discovery_channels drop constraint archive_discovery_channels_partition_check;
alter table public.archive_discovery_channels add constraint archive_discovery_channels_partition_check
  check (partition in ('ashby','greenhouse','greenhouse-legacy','lever','smartrecruiters','smartrecruiters-careers','workday','recruitee','workable','teamtailor','personio-de','personio-com'));
insert into public.archive_discovery_channels(partition)
  values ('teamtailor'),('personio-de'),('personio-com')
  on conflict (partition) do nothing;

do $$
declare definition text; updated text;
begin
  definition:=pg_get_functiondef('public.job_search_source_pool(uuid,text[])'::regprocedure);
  updated:=replace(definition,
    '''keka'',''zohorecruit'')',
    '''keka'',''zohorecruit'',''teamtailor'',''personio'')');
  if updated=definition then raise exception 'Unexpected source pool definition; review before migration'; end if;
  execute updated;
end $$;
