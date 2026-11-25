-- Large complete inventories need more than the local PostgREST role's eight
-- seconds. PostgREST hoists this function setting into the calling transaction;
-- other RPCs and role/session timeouts retain their existing limits.
alter function public.finish_catalog_source_task(uuid,uuid)
  set statement_timeout = '45s';
