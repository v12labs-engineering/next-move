alter table app_state
add column if not exists ai_search_runs jsonb not null default '[]'::jsonb;
