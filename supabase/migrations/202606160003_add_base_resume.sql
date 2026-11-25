alter table candidate_profiles
  add column if not exists base_resume_file_name text not null default '',
  add column if not exists base_resume_text text not null default '',
  add column if not exists base_resume_updated_at timestamptz;
