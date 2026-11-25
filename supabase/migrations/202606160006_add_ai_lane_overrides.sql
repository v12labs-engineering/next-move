alter table app_state
add column if not exists ai_lane_overrides jsonb not null default '[]'::jsonb;
