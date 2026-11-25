import { createClient } from "@supabase/supabase-js"
import { sourceTaskDatabase } from "./source-task-database"

/** PostgREST transport backed by real isolated Postgres, not mocked RPC results. */
export async function sourceWorkerDatabase(
  options: {
    beforeRpc?: (name: string) => void | Promise<void>
    afterRpc?: (name: string, timeoutMs?: number) => void | Promise<void>
  } = {}
) {
  const db = await sourceTaskDatabase(true)
  const database = (signal?: AbortSignal, timeoutMs?: number) =>
    createClient("https://database.example", "fixture-service-key", {
      auth: { persistSession: false },
      db: { retry: false },
      global: {
        fetch: async (input, init) => {
          const requestSignal = signal
            ? AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])])
            : init?.signal
          requestSignal?.throwIfAborted()
          const url = new URL(String(input))
          try {
            if (url.pathname.startsWith("/rest/v1/rpc/")) {
              const name = url.pathname.split("/").at(-1)!
              if (!/^[a-z_]+$/.test(name)) throw new Error("Invalid RPC name")
              const args: Record<string, unknown> = JSON.parse(
                String(init?.body ?? "{}")
              )
              const entries = Object.entries(args)
              if (entries.some(([key]) => !/^p_[a-z_]+$/.test(key)))
                throw new Error("Invalid RPC argument")
              const params = entries
                .map(([key], i) => `${key} => $${i + 1}`)
                .join(",")
              await options.beforeRpc?.(name)
              const result = await db.query<{ result: unknown }>(
                `select public.${name}(${params}) as result`,
                entries.map(([, value]) =>
                  value !== null && typeof value === "object"
                    ? JSON.stringify(value)
                    : value
                )
              )
              await options.afterRpc?.(name, timeoutMs)
              requestSignal?.throwIfAborted()
              return Response.json(result.rows[0].result)
            }
            // Existing retention/content helpers read listing identities before writing.
            if (url.pathname === "/rest/v1/job_catalog") {
              const filter = url.searchParams.get("id") ?? ""
              if (!filter.startsWith("in.("))
                throw new Error("Unbounded fixture catalogue read")
              const ids = filter
                .slice(4, -1)
                .split(",")
                .map((id) => id.replace(/^"|"$/g, ""))
              const result = await db.query(
                "select id,description_ref from job_catalog where id=any($1::text[])",
                [ids]
              )
              return Response.json(result.rows)
            }
            throw new Error(`Unexpected database request: ${url.pathname}`)
          } catch (error) {
            const message =
              error instanceof Error ? error.message : "Database request failed"
            const code =
              error && typeof error === "object" && "code" in error
                ? String(error.code)
                : "FIXTURE"
            return Response.json({ message, code }, { status: 400 })
          }
        },
      },
    })
  return { db, database }
}
