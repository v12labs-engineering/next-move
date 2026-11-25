-- Account gates are recorded per application destination. Sharing an ATS or a
-- company name is not evidence that two application flows have the same gate.
create table public.catalog_application_account_gates (
  target_url text primary key
);
alter table public.catalog_application_account_gates enable row level security;
revoke all on public.catalog_application_account_gates from public, anon, authenticated;

-- Employer routes checked in docs/research/2026-11-19-career-site-apply-access.md.
create function public.catalog_known_application_account_gate(p_url text)
returns boolean language sql immutable strict set search_path='' as $$
  select public.public_application_target(p_url) ~* (
    '^https://((www[.])?amazon[.]jobs/([a-z-]+/)?(applicant/)?jobs/'
    || '|careers[.]ibm[.]com/([a-z_]+/)?careers/(JobDetail|Login)([/?#]|$)'
    || '|southasiacareers[.]deloitte[.]com/(job/|talentcommunity/apply/)'
    || '|search[.]jobs[.]barclays/job/'
    || '|barclays[.]wd3[.]myworkdayjobs[.]com/([a-z-]+/)?External_Career_Site_Barclays/job/'
    || '|salesforce[.]wd12[.]myworkdayjobs[.]com/([a-z-]+/)?External_Career_Site/job/)'
  );
$$;

insert into public.catalog_application_account_gates(target_url)
select distinct public.application_target(r.target_url)
from public.application_tasks t join public.application_runs r on r.id=t.application_id
where t.error_code='employer_auth_required' and public.application_target(r.target_url) is not null;

-- Enforce scope for every publication route, including refreshes that try to
-- reactivate a listing. Keep rows available to existing application history.
create function public.catalog_enforce_india_application_scope()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.is_active and (
    new.country is distinct from 'India'
    or public.catalog_known_application_account_gate(new.url)
    or exists (select 1 from public.catalog_application_account_gates g
               where g.target_url=public.application_target(new.url))
  ) then
    new.is_active:=false;
  end if;
  return new;
end $$;
create trigger catalog_enforce_india_application_scope
before insert or update of country,url,is_active on public.job_catalog
for each row execute function public.catalog_enforce_india_application_scope();

update public.job_catalog j set is_active=false
where j.is_active and (
  j.country is distinct from 'India'
  or public.catalog_known_application_account_gate(j.url)
  or exists (select 1 from public.catalog_application_account_gates g
             where g.target_url=public.application_target(j.url))
);

-- The worker uses this error only after verifying a mandatory employer account
-- gate. Missing answers, OTP, CAPTCHA and generic authentication errors are
-- deliberately excluded. Keep only the destination from the private run.
create function public.catalog_record_application_account_gate()
returns trigger language plpgsql security definer set search_path='' as $$
declare destination text;
begin
  select public.application_target(target_url) into destination
  from public.application_runs where id=new.application_id;
  if destination is null then return null; end if;

  insert into public.catalog_application_account_gates(target_url) values(destination)
  on conflict do nothing;
  if found then
    update public.job_catalog set is_active=false
    where is_active and country='India' and public.application_target(url)=destination;
  end if;
  return null;
end $$;
create trigger catalog_record_application_account_gate
after insert or update of error_code on public.application_tasks
for each row when (new.error_code='employer_auth_required')
execute function public.catalog_record_application_account_gate();

revoke all on function public.catalog_known_application_account_gate(text),
  public.catalog_enforce_india_application_scope(),
  public.catalog_record_application_account_gate() from public, anon, authenticated;
