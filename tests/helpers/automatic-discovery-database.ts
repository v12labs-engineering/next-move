import { readFile } from "node:fs/promises"
import { createClient } from "@supabase/supabase-js"
import { sourceTaskDatabase } from "./source-task-database"

export async function automaticDiscoveryDatabase(
  afterRpc?: (name: string) => void
) {
  const sql = await sourceTaskDatabase(true)
  await sql.exec("reset role")
  await sql.exec(
    await readFile(
      new URL(
        "../../supabase/migrations/202611040050_automatic_source_discovery.sql",
        import.meta.url
      ),
      "utf8"
    )
  )
  await sql.exec("set role service_role")
  const database = createClient("https://database.example", "fixture-key", {
    auth: { persistSession: false },
    db: { retry: false },
    global: {
      fetch: async (input, init) => {
        const url = new URL(String(input))
        try {
          if (url.pathname.startsWith("/rest/v1/rpc/")) {
            const name = url.pathname.split("/").at(-1)!
            if (!/^[a-z_]+$/.test(name)) throw new Error("Bad RPC")
            const entries = Object.entries(
              JSON.parse(String(init?.body ?? "{}"))
            )
            if (entries.some(([key]) => !/^p_[a-z_]+$/.test(key)))
              throw new Error("Bad parameter")
            const params = entries
              .map(([key], i) => `${key} => $${i + 1}`)
              .join(",")
            const result = await sql.query<{ result: unknown }>(
              `select public.${name}(${params}) as result`,
              entries.map(([key, value]) =>
                key === "p_countries"
                  ? value
                  : value !== null && typeof value === "object"
                    ? JSON.stringify(value)
                    : value
              )
            )
            afterRpc?.(name)
            return Response.json(result.rows[0].result)
          }
          if (url.pathname.endsWith("/catalog_capacity_control")) {
            const r = await sql.query(
              "select budget_bytes from catalog_capacity_control"
            )
            return Response.json(r.rows[0])
          }
          if (url.pathname.endsWith("/job_source_directory")) {
            const after = url.searchParams.get("id")?.replace(/^gt\./, "") ?? ""
            return Response.json(
              (
                await sql.query(
                  "select id from job_source_directory where enabled and id>$1 order by id limit 500",
                  [after]
                )
              ).rows
            )
          }
          if (url.pathname.endsWith("/source_candidates")) {
            const filter = url.searchParams.get("id") ?? ""
            if (!filter.startsWith("in.("))
              throw new Error("Expected scoped candidates")
            const ids = filter
              .slice(4, -1)
              .split(",")
              .map((id) => id.replace(/^"|"$/g, ""))
            return Response.json(
              (
                await sql.query(
                  "select * from source_candidates where id=any($1::text[]) and ($2::boolean or status not in ('activated','invalid')) order by next_attempt_at,id",
                  [ids, !url.searchParams.has("status")]
                )
              ).rows
            )
          }
          throw new Error("Unexpected fixture endpoint")
        } catch (error) {
          return Response.json(
            {
              message:
                error instanceof Error ? error.message : "Fixture failed",
              code: "FIXTURE",
            },
            { status: 400 }
          )
        }
      },
    },
  })
  async function rpc<T = Record<string, unknown>>(
    name: string,
    args: unknown[] = []
  ) {
    const result = await sql.query<{ result: T }>(
      `select public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) as result`,
      args.map((value, index) =>
        name === "initialize_automatic_discovery" && index === 0
          ? value
          : value !== null && typeof value === "object"
            ? JSON.stringify(value)
            : value
      )
    )
    return result.rows[0].result
  }
  return { sql, database, rpc }
}
