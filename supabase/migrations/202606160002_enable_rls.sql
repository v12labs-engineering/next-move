alter table candidate_profiles enable row level security;
alter table country_scores enable row level security;
alter table companies enable row level security;
alter table jobs enable row level security;
alter table people enable row level security;
alter table drafts enable row level security;
alter table applications enable row level security;
alter table source_connectors enable row level security;
alter table prompt_templates enable row level security;
alter table app_state enable row level security;

create policy "authenticated users can manage candidate profiles"
on candidate_profiles for all
to authenticated
using (true)
with check (true);

create policy "authenticated users can manage country scores"
on country_scores for all
to authenticated
using (true)
with check (true);

create policy "authenticated users can manage companies"
on companies for all
to authenticated
using (true)
with check (true);

create policy "authenticated users can manage jobs"
on jobs for all
to authenticated
using (true)
with check (true);

create policy "authenticated users can manage people"
on people for all
to authenticated
using (true)
with check (true);

create policy "authenticated users can manage drafts"
on drafts for all
to authenticated
using (true)
with check (true);

create policy "authenticated users can manage applications"
on applications for all
to authenticated
using (true)
with check (true);

create policy "authenticated users can manage source connectors"
on source_connectors for all
to authenticated
using (true)
with check (true);

create policy "authenticated users can manage prompt templates"
on prompt_templates for all
to authenticated
using (true)
with check (true);

create policy "authenticated users can manage app state"
on app_state for all
to authenticated
using (true)
with check (true);
