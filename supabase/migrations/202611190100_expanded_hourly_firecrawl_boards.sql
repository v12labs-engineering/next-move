do $$
declare definition text; updated text;
begin
  definition:=pg_get_functiondef('public.catalog_board_details_to_check(uuid,uuid,jsonb)'::regprocedure);
  updated:=replace(definition, '''indiaboard:e2ehiring'',',
    '''indiaboard:cyberpark'',''indiaboard:egig'',''indiaboard:e2ehiring'',');
  if updated=definition then raise exception 'Unexpected Firecrawl board allowlist'; end if;
  execute updated;
end $$;
