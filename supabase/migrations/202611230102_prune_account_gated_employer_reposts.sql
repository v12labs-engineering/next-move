-- Aggregators can publish a redirect without exposing the underlying employer
-- URL. Match explicit employer names for the reviewed account-gated employers.
create function public.catalog_account_gated_employer(p_company text)
returns boolean language sql immutable strict set search_path='' as $$
  select lower(btrim(p_company)) in ('amazon','barclays','deloitte','deloitte india','ibm','salesforce');
$$;

create or replace function public.catalog_enforce_india_application_scope()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.is_active and (
    new.country is distinct from 'India'
    or public.catalog_account_gated_employer(new.company)
    or public.catalog_known_application_account_gate(new.url)
    or exists (select 1 from public.catalog_application_account_gates g
               where g.target_url=public.application_target(new.url))
  ) then
    new.is_active:=false;
  end if;
  return new;
end $$;

create or replace trigger catalog_enforce_india_application_scope
before insert or update of country,company,url,is_active on public.job_catalog
for each row execute function public.catalog_enforce_india_application_scope();

update public.job_catalog set is_active=false
where is_active and public.catalog_account_gated_employer(company);

revoke all on function public.catalog_account_gated_employer(text) from public, anon, authenticated;
