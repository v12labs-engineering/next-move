-- Keep historical Adzuna rows available to existing application references.
update public.job_source_directory set enabled=false where kind='adzuna' and enabled;
alter table public.job_source_directory add constraint job_source_directory_adzuna_retired
  check (kind<>'adzuna' or not enabled);

-- Fence already-dispatched work and keep retired tasks out of scheduler recovery.
update public.catalog_source_tasks t
set state='failed', dispatch_generation=dispatch_generation+1,
    lease_token=null, lease_until=null, updated_at=now(), finished_at=now(),
    result=jsonb_build_object('state','failed','reason','source_retired')
from public.job_source_directory d
where t.source_id=d.id and d.kind='adzuna' and t.state in ('pending','running','waiting');

create function public.catalog_is_adzuna_listing(p_source text,p_url text)
returns boolean language sql immutable strict set search_path='' as $$
  select lower(split_part(p_source,':',1))='adzuna'
    or p_url ~* '^https?://([a-z0-9-]+[.])*adzuna[.][a-z]{2,3}([.][a-z]{2})?[.]?(:[0-9]+)?([/?#]|$)';
$$;

create or replace function public.catalog_enforce_india_application_scope()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.is_active and (
    new.country is distinct from 'India'
    or public.catalog_is_adzuna_listing(new.source,new.url)
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
before insert or update of country,company,source,url,is_active on public.job_catalog
for each row execute function public.catalog_enforce_india_application_scope();

update public.job_catalog set is_active=false
where is_active and public.catalog_is_adzuna_listing(source,url);

revoke all on function public.catalog_is_adzuna_listing(text,text) from public, anon, authenticated;
