import { readdir, readFile, realpath, stat } from "node:fs/promises"
import path from "node:path"

// NFT traces describe uncompressed runtime dependencies, not Vercel billing.
// Check actual build artifacts so ignored developer files cannot ship in a
// prebuilt function, and keep individual traces well below the platform limit.
const maxBytes = 50 * 1024 * 1024
const root = process.cwd()
const traces = []
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = path.join(directory, entry.name)
    if (entry.isDirectory()) await collect(name)
    else if (name.endsWith(".nft.json")) traces.push(name)
  }
}
await collect(path.join(root, ".next/server"))
if (!traces.length)
  throw new Error("No function traces found. Run next build first.")

const privatePath = (name) =>
  name
    .split(path.sep)
    .some(
      (part) =>
        part === ".local-data" || part === ".git" || /^\.env(?:\.|$)/.test(part)
    )
const sizes = new Map()
const rows = []
for (const trace of traces.sort()) {
  const manifest = JSON.parse(await readFile(trace, "utf8"))
  const files = new Set()
  let privateFiles = 0,
    missingFiles = 0,
    bytes = 0
  for (const entry of [
    path.basename(trace).replace(/\.nft\.json$/, ""),
    ...manifest.files,
  ]) {
    const name = path.resolve(path.dirname(trace), entry)
    try {
      const canonical = await realpath(name)
      if (files.has(canonical)) continue
      files.add(canonical)
      if (privatePath(name) || privatePath(canonical)) privateFiles++
      if (!sizes.has(canonical))
        sizes.set(canonical, (await stat(canonical)).size)
      bytes += sizes.get(canonical)
    } catch {
      missingFiles++
    }
  }
  rows.push({
    trace: path.relative(root, trace),
    bytes,
    privateFiles,
    missingFiles,
  })
}
const failures = rows.filter(
  (row) => row.bytes > maxBytes || row.privateFiles || row.missingFiles
)
console.log(
  JSON.stringify(
    {
      traces: rows.length,
      perTraceBudgetMiB: 50,
      uniqueTracedMiB: Number(
        ([...sizes.values()].reduce((a, b) => a + b, 0) / 1048576).toFixed(2)
      ),
      largest: [...rows]
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, 5)
        .map((row) => ({
          trace: row.trace,
          MiB: Number((row.bytes / 1048576).toFixed(2)),
        })),
      violations: failures.map((row) => ({
        trace: row.trace,
        MiB: Number((row.bytes / 1048576).toFixed(2)),
        privateFiles: row.privateFiles,
        missingFiles: row.missingFiles,
      })),
    },
    null,
    2
  )
)
if (failures.length) {
  console.error(
    "Function bundle audit failed: remove private files, missing dependencies or oversized traces."
  )
  process.exitCode = 1
}
