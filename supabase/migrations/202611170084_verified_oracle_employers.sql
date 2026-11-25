-- Public career sites and India feeds independently verified on 2026-11-17.
-- Register permitted tenant identifiers only. Activation remains a separate
-- measured rollout action; this migration creates or enables no source row.
alter table public.job_source_directory drop constraint job_source_directory_regional_scope;
alter table public.job_source_directory add constraint job_source_directory_regional_scope check (
  (kind <> 'infopark' or board = 'kerala') and
  (kind <> 'oracle' or board in ('bny','ibs-software','oracle-india','jpmorgan-chase','honeywell','nokia','emerson'))
);
