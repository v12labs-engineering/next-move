import { PGlite } from "@electric-sql/pglite"
import { readFile, readdir } from "node:fs/promises"

export async function sourceTaskDatabase(publicSchema = false) {
  const db = new PGlite()
  try {
    await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    grant usage on schema public to anon,authenticated,service_role;
  `)
    let files: string[]
    if (publicSchema) {
      await db.exec(`create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth to anon,authenticated,service_role;`)
      files = [
        "202606160001_initial_schema.sql",
        "202606160002_enable_rls.sql",
        "202606290002_normalized_runtime_state.sql",
        ...(
          await readdir(new URL("../../supabase/migrations/", import.meta.url))
        )
          .filter(
            (file) =>
              file >= "202610290001_public_accounts.sql" &&
              file <= "202611020040_catalog_source_worker.sql"
          )
          .sort(),
      ]
    } else {
      await db.exec(`
    create type visa_confidence as enum('confirmed','possible','no');
    create table job_catalog(id text primary key,title text not null,company text not null,
      country text not null,city text,url text not null,description text not null,
      work_mode text not null,visa_signal visa_confidence,sponsorship_evidence text,
      sponsor_verified boolean,source text,posted_at timestamptz,discovered_at timestamptz default now());
    grant all on job_catalog to service_role;
    create table account_countries(user_id uuid,country text);
  `)
      files = [
        "202610290002_live_catalog.sql",
        "202610290006_catalog_collection.sql",
        "202610290007_catalog_backoff.sql",
        "202610300006_catalog_capacity.sql",
        "202610300010_catalog_storage_reservations.sql",
        "202610300013_catalog_refresh_unchanged.sql",
        "202610300014_catalog_posted_date_comparison.sql",
        "202611020039_catalog_source_tasks.sql",
        "202611020040_catalog_source_worker.sql",
      ]
    }
    for (const file of files) {
      await db.exec(
        await readFile(
          new URL(`../../supabase/migrations/${file}`, import.meta.url),
          "utf8"
        )
      )
    }
    await db.exec("set role service_role")
    return db
  } catch (error) {
    await db.close()
    throw error
  }
}

export type SourceTask = {
  id: string
  source_id: string
  state: "pending" | "running" | "waiting" | "completed" | "failed"
  dispatch_generation: number
  run_id: string | null
  lease_token: string | null
  attempts: number
  failure_count?: number
  result: Record<string, unknown> | null
  run?: {
    pages: number
    next_page: number | null
    fetched_count: number
    accepted_count: number
    request_count: number
  }
  receipt_count?: number
}

export function taskOperations(db: PGlite) {
  async function rpc<T>(sql: string, args: unknown[] = []) {
    return (await db.query<{ result: T }>(`select ${sql} as result`, args))
      .rows[0].result
  }
  return {
    rpc,
    request: (key = "scheduled-epoch-one", source = "ashby:n8n") =>
      rpc<SourceTask>("request_catalog_source_task($1,$2)", [source, key]),
    read: (id: string) => rpc<SourceTask>("read_catalog_source_task($1)", [id]),
    claim: (id: string, generation = 1) =>
      rpc<SourceTask & { claimed: boolean; reason?: string }>(
        "claim_catalog_source_task($1,$2)",
        [id, generation]
      ),
    outbox: () =>
      rpc<
        {
          id: string
          task_id: string
          dispatch_generation: number
          lease_token: string
        }[]
      >("claim_catalog_task_outbox(10)"),
  }
}
