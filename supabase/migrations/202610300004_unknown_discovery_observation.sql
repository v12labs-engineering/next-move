-- Directory revisions have dates, but Open ATS Feed CSV rows have no individual
-- observation timestamps. Preserve that unknown instead of using the Git date.
alter table public.source_candidate_observations alter column historical_checked_at drop not null;
update public.source_candidate_observations observation set historical_checked_at=null
  from public.source_discovery_origins origin
  where origin.id=observation.origin_id and origin.metadata->>'format'='open-ats-feed';
