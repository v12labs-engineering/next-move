alter table jobs
  add column if not exists ai_fit_score integer,
  add column if not exists ai_visa_score integer,
  add column if not exists ai_overall_score integer,
  add column if not exists ai_summary text,
  add column if not exists ai_why jsonb,
  add column if not exists ai_risks jsonb,
  add column if not exists ai_last_analyzed_at timestamptz;
