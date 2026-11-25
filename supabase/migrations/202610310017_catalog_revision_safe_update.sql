-- Hosted safeupdate rejects the previous unqualified singleton UPDATE when a
-- catalogue DELETE fires this statement trigger. Preserve the guard and target
-- the singleton primary key explicitly.
create or replace function public.bump_catalog_match_revision() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  update public.catalog_match_revision set revision=revision+1 where id=true;
  return null;
end $$;
