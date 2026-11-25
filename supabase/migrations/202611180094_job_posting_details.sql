-- Nullable posting facts. No table rewrite or guesses for existing rows.
alter table public.job_catalog add column posting_details jsonb;

-- Keep the deployed publishers' lease, retention, capacity, and retry semantics.
do $$
declare target regprocedure; definition text; original text; observation text; previous_details text; compared_fields text;
begin
  foreach target in array array[
    'public.finish_catalog_run_without_capacity(uuid,uuid)'::regprocedure,
    'public.publish_job_search_source(uuid,uuid,text,jsonb,boolean,integer,integer)'::regprocedure
  ] loop
    original:=pg_get_functiondef(target);
    if target='public.finish_catalog_run_without_capacity(uuid,uuid)'::regprocedure then
      observation:='i.data';
      previous_details:='existing.posting_details';
    else
      observation:='x';
      previous_details:='j.posting_details';
    end if;
    definition:=replace(original, 'description_ref,work_mode,visa_signal,sponsorship_evidence,sponsor_verified,source,posted_at,is_active,last_checked_at)',
      'description_ref,posting_details,work_mode,visa_signal,sponsorship_evidence,sponsor_verified,source,posted_at,is_active,last_checked_at)');
    definition:=replace(definition, 'x.description_ref,x.work_mode', 'x.description_ref,x.posting_details,x.work_mode');
    definition:=replace(definition, 'description_ref jsonb,work_mode text', 'description_ref jsonb,posting_details jsonb,work_mode text');
    definition:=replace(definition, 'description_ref=excluded.description_ref,work_mode=excluded.work_mode',
      'description_ref=excluded.description_ref,posting_details=excluded.posting_details,work_mode=excluded.work_mode');
    -- Preserve the unchanged-posting fast path for payloads with omitted details.
    definition:=replace(definition, '''posted_at'',''description'',''description_ref'']',
      '''posted_at'',''description'',''description_ref'',''posting_details'']');
    compared_fields:=format('(%s-array[''sponsor_verified'',''posted_at'',''description'',''description_ref'',''posting_details''])',observation);
    definition:=replace(definition, compared_fields,
      compared_fields||format(' or %s is distinct from nullif(%s->''posting_details'',''null''::jsonb)',previous_details,observation));
    if observation='i.data' then
      definition:=replace(definition, 'j.posted_at,public.catalog_description_fingerprint',
        'j.posting_details,j.posted_at,public.catalog_description_fingerprint');
    end if;
    if position('posting_details=excluded.posting_details' in definition)=0
       or position('x.description_ref,x.posting_details,x.work_mode' in definition)=0
       or position('description_ref jsonb,posting_details jsonb' in definition)=0
       or position('description_ref,posting_details,work_mode' in definition)=0
       or position('is distinct from nullif('||observation||'->''posting_details''' in definition)=0
      then raise exception 'Unexpected catalog publisher definition: %',target;
    end if;
    execute definition;
  end loop;

  original:=pg_get_functiondef('public.catalog_matching_batch(text[],timestamptz,text,integer)'::regprocedure);
  definition:=replace(original, 'sponsorship_evidence,sponsor_verified,source,posted_at,last_checked_at,',
    'sponsorship_evidence,sponsor_verified,source,posted_at,last_checked_at,posting_details,');
  if definition=original then raise exception 'Unexpected catalog matching batch definition'; end if;
  execute definition;

  original:=pg_get_functiondef('public.read_account_matches_for(uuid,jsonb)'::regprocedure);
  definition:=replace(original, '      and (p_filters->>''category''', $filters$
      and (p_filters->>'employmentType' is null
        or (p_filters->>'employmentType'='unknown'
          and coalesce(nullif(job->'postingDetails'->'employmentTypes','null'),'[]')='[]')
        or (job->'postingDetails'->'employmentTypes' ? (p_filters->>'employmentType')))
      and (p_filters->>'experienceLevel' is null
        or coalesce(job->'postingDetails'->>'experienceLevel','unknown')=p_filters->>'experienceLevel')
      and (case p_filters->>'salary'
        when 'disclosed' then jsonb_typeof(job->'postingDetails'->'salary')='object'
        when 'unknown' then jsonb_typeof(job->'postingDetails'->'salary') is distinct from 'object'
        else p_filters->>'salary' is null or case
          when p_filters->>'salary' ~ '^[0-9]{1,9}$'
            and job->'postingDetails'->'salary'->>'currency'='INR'
            and jsonb_typeof(job->'postingDetails'->'salary'->'min')='number'
          then (job->'postingDetails'->'salary'->>'min')::numeric
            * case job->'postingDetails'->'salary'->>'period'
                when 'year' then 1 when 'month' then 12 end >= (p_filters->>'salary')::numeric
          else false end end)
      and (p_filters->>'category'$filters$);
  if definition=original then raise exception 'Unexpected account match reader definition'; end if;
  execute definition;
end $$;
