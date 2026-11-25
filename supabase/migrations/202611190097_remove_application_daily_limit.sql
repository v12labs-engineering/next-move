-- Keep admission serialized per account for deduplication and plan quotas.
create or replace function public.create_application_for(p_user uuid, p_job text) returns uuid
language plpgsql security definer set search_path='' as $$
declare j public.job_catalog; v_id uuid; v_url text;
begin
  perform 1 from public.account_profiles where user_id = p_user for update;
  if not found then raise exception 'Complete your profile'; end if;
  select * into j from public.job_catalog where id = p_job and is_active and last_checked_at > now() - interval '7 days';
  if not found then raise exception 'Unsupported or expired listing'; end if;
  v_url := public.application_target(j.url);
  if v_url is null then raise exception 'A public HTTPS listing is required'; end if;
  select id into v_id from public.application_runs where user_id = p_user and (job_id = j.id or target_url = v_url) order by (job_id = j.id) desc limit 1;
  if v_id is not null then return v_id; end if;
  if (select count(*) from public.application_runs where user_id = p_user and created_at > now() - interval '30 days')
    >= (public.account_limits(p_user)).monthly_applications then
    raise exception 'Monthly application limit reached';
  end if;
  if not public.reserve_ai_attempt(p_user) then raise exception 'Monthly AI limit reached'; end if;
  insert into public.application_runs(user_id, job_id, target_url, employer_key)
  values (p_user, j.id, v_url, coalesce(nullif(lower(btrim(j.company)), ''), split_part(v_url, '/', 3))) returning id into v_id;
  return v_id;
end $$;
revoke all on function public.create_application_for(uuid, text) from public, anon, authenticated;
