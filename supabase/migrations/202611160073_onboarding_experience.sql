create function public.require_onboarding_experience() returns trigger
language plpgsql set search_path = '' as $$
begin
  if jsonb_typeof(new.data->'experienceYears') is distinct from 'number'
    or new.data->'experienceYears' < '2'::jsonb then
    raise exception 'New profiles require at least 2 years of professional experience.'
      using errcode = '23514';
  end if;
  return null;
end;
$$;

-- AFTER INSERT also covers direct inserts. Existing profiles use the UPDATE
-- path of save_candidate's upsert, so older experience data remains editable.
create trigger require_onboarding_experience
after insert on public.account_profiles
for each row execute function public.require_onboarding_experience();
