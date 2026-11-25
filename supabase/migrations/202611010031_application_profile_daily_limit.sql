-- Reusable application details live in the existing owner-protected profile
-- JSON and application packet. Enforce the candidate's optional daily cap at
-- the serialized admission point shared by browser and background requests.
create or replace function public.create_application_for(p_user uuid, p_job text) returns uuid
language plpgsql security definer set search_path='' as $$
declare j public.job_catalog; v_id uuid; v_url text; profile_data jsonb; daily_limit integer;
begin
  select data into profile_data from public.account_profiles where user_id=p_user for update;
  if not found then raise exception 'Complete your profile'; end if;
  select * into j from public.job_catalog where id=p_job and is_active and last_checked_at>now()-interval '7 days';
  if not found then raise exception 'Unsupported or expired listing'; end if;
  v_url:=public.application_target(j.url);
  if v_url is null then raise exception 'A public HTTPS listing is required'; end if;
  select id into v_id from public.application_runs where user_id=p_user and (job_id=j.id or target_url=v_url) order by (job_id=j.id) desc limit 1;
  if v_id is not null then return v_id; end if;
  if (profile_data->'autoApply'->>'dailyLimit') ~ '^[0-9]{1,2}$' then
    daily_limit:=greatest(1,least(50,(profile_data->'autoApply'->>'dailyLimit')::integer));
    if (select count(*) from public.application_runs where user_id=p_user and created_at>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC')>=daily_limit then
      raise exception 'Daily application limit reached';
    end if;
  end if;
  if (select count(*) from public.application_runs where user_id=p_user and created_at>now()-interval '30 days') >= (public.account_limits(p_user)).monthly_applications then
    raise exception 'Monthly application limit reached';
  end if;
  if not public.reserve_ai_attempt(p_user) then raise exception 'Monthly AI limit reached'; end if;
  insert into public.application_runs(user_id,job_id,target_url,employer_key)
    values(p_user,j.id,v_url,coalesce(nullif(lower(btrim(j.company)),''),split_part(v_url,'/',3))) returning id into v_id;
  return v_id;
end $$;
revoke all on function public.create_application_for(uuid,text) from public,anon,authenticated;
