-- Large sweeps should not scan already checked, description-adjacent metadata
-- when locating unfinished work or restoring provider throttles.
create index source_candidates_unchecked_id_idx on public.source_candidates(id)
  where validated_at is null and status in ('imported','validating');
create index source_candidates_status_due_idx on public.source_candidates(status,next_attempt_at,id);
