import { createHash } from "node:crypto"

/** Exact, backed-up observations only. Changed rows and account history survive. */
export function softwareScopeCleanupSql(rows, staged = false) {
  if (!rows.length || rows.length > 1000)
    throw new Error("Invalid cleanup batch")
  const candidates = rows.map((entry) => {
    const row = staged ? entry.data : entry
    return {
      id: entry.id,
      run_id: staged ? entry.run_id : null,
      title: row.title,
      description_hash: createHash("md5")
        .update(row.description ?? "")
        .digest("hex"),
      description_ref: row.description_ref ?? null,
    }
  })
  const json = JSON.stringify(candidates).replaceAll("'", "''")
  const table = staged ? "job_catalog_run_items" : "job_catalog"
  const title = staged ? "j.data->>'title'" : "j.title"
  const description = staged
    ? "coalesce(j.data->>'description','')"
    : "j.description"
  const ref = staged ? "j.data->'description_ref'" : "j.description_ref"
  const history = staged
    ? ""
    : `
    and not exists(select 1 from public.account_job_states a where a.job_id=j.id and a.status in ('interested','applied'))
    and not exists(select 1 from public.resume_drafts d where d.job_id=j.id)
    and not exists(select 1 from public.application_runs a where a.job_id=j.id or a.target_url=j.url)`
  return `begin;
set local lock_timeout='5s';
set local statement_timeout='50s';
set local standard_conforming_strings=on;
select pg_catalog.pg_advisory_xact_lock(730103116);
lock table public.account_job_states,public.resume_drafts,public.application_runs in share mode;
with candidates as materialized (
  select * from jsonb_to_recordset('${json}'::jsonb)
    as c(id text,run_id uuid,title text,description_hash text,description_ref jsonb)
), deleted as (
  delete from public.${table} j using candidates c
  where j.id=c.id ${staged ? "and j.run_id=c.run_id" : ""}
    and ${title}=c.title and md5(${description})=c.description_hash
    and coalesce(${ref},'null'::jsonb)=coalesce(c.description_ref,'null'::jsonb)${history}
  returning j.id
)
select (select count(*) from candidates)::integer as requested,
  (select count(*) from deleted)::integer as deleted;
commit;
`
}
