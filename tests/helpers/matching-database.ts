import { PGlite } from "@electric-sql/pglite"
import { readFile } from "node:fs/promises"

export const MATCH_USER = "00000000-0000-4000-8000-000000000001"
export const OTHER_MATCH_USER = "00000000-0000-4000-8000-000000000002"

export async function matchingDatabase() {
  const db = new PGlite()
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema public,auth to authenticated,anon,service_role;
    create table account_profiles(user_id uuid primary key references auth.users,version integer not null,data jsonb default '{}');
    create table account_countries(user_id uuid,country text,added_at timestamptz default now());
    create table job_catalog(id text primary key,country text default 'Germany',title text default 'Backend Engineer',is_active boolean default true,last_checked_at timestamptz default now());
    create table account_job_states(user_id uuid,job_id text,status text,updated_at timestamptz default now(),primary key(user_id,job_id));
    create table catalog_capacity_control(singleton boolean primary key,budget_bytes bigint);
    insert into catalog_capacity_control values(true,419430400);
    insert into auth.users values('${MATCH_USER}'),('${OTHER_MATCH_USER}');
    insert into account_profiles(user_id,version) values('${MATCH_USER}',1),('${OTHER_MATCH_USER}',1);
    insert into account_countries(user_id,country) values('${MATCH_USER}','Germany'),('${OTHER_MATCH_USER}','Germany');
    create index job_catalog_active_matching_cursor_idx on job_catalog(country,id) include(last_checked_at) where is_active;
    grant select on account_profiles,account_countries,job_catalog,account_job_states,catalog_capacity_control to service_role;`)
  for (const file of [
    "202610310011_precomputed_matches.sql",
    "202610310015_match_posting_window.sql",
    "202610310018_matching_engine.sql",
    "202610310019_matching_publish_policy.sql",
    "202610310020_safe_matching_activation.sql",
  ]) {
    await db.exec(
      await readFile(
        new URL(`../../supabase/migrations/${file}`, import.meta.url),
        "utf8"
      )
    )
  }
  return db
}
