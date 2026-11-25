-- Register reviewed public employer readers. Activation and collection require
-- separate live verification; this migration enables no source.
alter table public.job_source_directory drop constraint job_source_directory_kind_check;
alter table public.job_source_directory add constraint job_source_directory_kind_check
  check (kind in ('ashby','greenhouse','lever','arbeitnow','smartrecruiters','workday','linkedin','recruitee','workable','alexandria','amazon','infopark','oracle','keka','zohorecruit','teamtailor','personio','adzuna','jobtech','accenture'));

alter table public.job_source_directory drop constraint job_source_directory_amazon_scope;
alter table public.job_source_directory add constraint job_source_directory_amazon_scope
  check (kind <> 'amazon' or board in ('india-software','india'));
alter table public.job_source_directory drop constraint job_source_directory_regional_scope;
alter table public.job_source_directory add constraint job_source_directory_regional_scope check (
  (kind <> 'infopark' or board = 'kerala') and
  (kind <> 'oracle' or board in ('bny','ibs-software','oracle-india'))
);
alter table public.job_source_directory add constraint job_source_directory_accenture_scope check (
  kind <> 'accenture' or (
    company = 'Accenture' and jsonb_typeof(config) = 'object' and
    config ? 'family' and config - 'family' = '{}'::jsonb and
    board = case config->>'family'
      when 'Software Engineering' then 'india-software-engineering'
      when 'Artificial Intelligence (AI) & Data Science' then 'india-artificial-intelligence-ai-data-science'
      when 'Marketing & Communication' then 'india-marketing-communication'
      when 'Sales & Account Management' then 'india-sales-account-management'
      when 'Product Development' then 'india-product-development'
      when 'Creative & Design' then 'india-creative-design'
      when 'Customer & User Experience' then 'india-customer-user-experience'
      when 'Cloud' then 'india-cloud'
      when 'Security' then 'india-security'
      when 'Technology Platforms' then 'india-technology-platforms'
      when 'Programming Languages' then 'india-programming-languages'
      else '' end
  )
);

do $$
declare definition text; updated text;
begin
  definition := pg_get_functiondef('public.job_search_source_pool(uuid,text[])'::regprocedure);
  updated := replace(definition,
    '''teamtailor'',''personio'')',
    '''teamtailor'',''personio'',''amazon'',''oracle'',''accenture'')');
  if updated = definition then raise exception 'Unexpected source pool definition; review before migration'; end if;
  execute updated;
end $$;
