-- The live batched UPDATE periodically exceeded the free-tier statement timeout.
-- Pin each compare-and-swap to one primary-key lookup; do not scan/hash unrelated
-- source descriptions when the planner changes its join strategy.
create or replace function public.attach_catalog_description_refs(p_rows jsonb) returns integer
language plpgsql security invoker set search_path='' as $$
declare changed integer:=0; affected integer; item record;
begin
 if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)>256 then raise exception 'Invalid archive batch'; end if;
 if exists(select 1 from jsonb_array_elements(p_rows) x where
   not coalesce(public.valid_catalog_description_ref(x->'description_ref'),false) or jsonb_typeof(x->'description_ref') is distinct from 'object')
   then raise exception 'Unverified description reference'; end if;
 for item in select * from jsonb_to_recordset(p_rows) as x(id text,description_ref jsonb) loop
  update public.job_catalog j set description='',description_ref=item.description_ref
   where j.id=item.id and j.description_ref is null
    and encode(sha256(convert_to(j.description,'UTF8')),'hex')=item.description_ref->>'sha256';
  get diagnostics affected=row_count;
  changed:=changed+affected;
 end loop;
 return changed;
end $$;
