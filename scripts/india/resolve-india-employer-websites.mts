import { readFile, rename, writeFile } from "node:fs/promises"
import { parseArgs } from "node:util"
import { probeEmployerSites } from "../lib/employer-site-probe.mjs"

const data = new URL("../../.local-data/", import.meta.url)
const seed = new URL(
  "../deploy/local/india-employers/resolved-domain.json",
  import.meta.url
)
const receipt = new URL("india-employer-domain-probes.json", data)
const { values } = parseArgs({
  options: {
    limit: { type: "string", default: "100" },
    "audit-confirmed": { type: "boolean" },
  },
})
const limit = Number(values.limit)
if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1500)
  throw new Error("Use --limit 1–1500")

type Employer = {
  id: string
  name: string
  observations: { website?: string }[]
}
type Outcome = {
  id: string
  attemptedAt: string
  result: "confirmed" | "ambiguous" | "unresolved"
  matches: Awaited<ReturnType<typeof probeEmployerSites>>
}

async function probe(employer: Employer): Promise<Outcome> {
  const matches = await probeEmployerSites(employer.name)
  return {
    id: employer.id,
    attemptedAt: new Date().toISOString(),
    result:
      matches.length === 1
        ? "confirmed"
        : matches.length > 1
          ? "ambiguous"
          : "unresolved",
    matches,
  }
}

async function save(url: URL, rows: unknown) {
  const temporary = new URL(`${url.pathname}.${process.pid}.tmp`, url)
  await writeFile(temporary, JSON.stringify(rows, null, 2) + "\n")
  await rename(temporary, url)
}

const directory = JSON.parse(
  await readFile(new URL("india-employer-directory.json", data), "utf8")
) as { employers: Employer[] }
let previous: Outcome[] = []
try {
  previous = JSON.parse(await readFile(receipt, "utf8"))
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
}
const byId = new Map(previous.map((row) => [row.id, row]))
const queue = directory.employers
  .filter((employer) =>
    values["audit-confirmed"]
      ? byId.get(employer.id)?.result === "confirmed"
      : !byId.has(employer.id) &&
        !employer.observations.some((row) => row.website)
  )
  .slice(0, limit)
for (let offset = 0; offset < queue.length; offset += 16) {
  for (const row of await Promise.all(
    queue.slice(offset, offset + 16).map(probe)
  ))
    byId.set(row.id, row)
  await save(receipt, [...byId.values()])
  await save(
    seed,
    [...byId.values()].flatMap((row) =>
      row.result === "confirmed" ? row.matches : []
    )
  )
  if ((offset + 16) % 64 === 0 || offset + 16 >= queue.length)
    console.error(
      `Company identity probes ${Math.min(offset + 16, queue.length)}/${queue.length}`
    )
}
console.log(
  JSON.stringify(
    {
      attempted: byId.size,
      confirmed: [...byId.values()].filter((row) => row.result === "confirmed")
        .length,
      ambiguous: [...byId.values()].filter((row) => row.result === "ambiguous")
        .length,
    },
    null,
    2
  )
)
