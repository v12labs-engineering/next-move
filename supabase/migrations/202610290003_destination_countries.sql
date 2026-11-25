-- Destination preferences are independent of the countries covered by a source.
-- The profile API canonicalizes real country names; retain basic input bounds
-- here without tying account preferences to a fixed ingestion allowlist.
alter table public.account_countries
  drop constraint account_countries_country_check;

alter table public.account_countries
  add constraint account_countries_country_check check (
    country = btrim(country)
    and char_length(country) between 2 and 100
    and country !~ '[[:cntrl:]]'
  );
