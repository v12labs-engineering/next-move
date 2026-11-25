import { execFile } from "node:child_process"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import type { SponsorSeed } from "@/lib/server/sponsor-sources/types"
import { fetchSourceBuffer } from "@/lib/server/sponsor-sources/fetch"

const execFileAsync = promisify(execFile)

export const AU_FOI_PDF_URL =
  "https://www.homeaffairs.gov.au/foi/files/2024/fa-240100298-document-released.PDF"

/**
 * Australia — STALE accredited-sponsor seed from a 2024 FOI PDF.
 *
 * Australia has no live public sponsor register yet (the bill passed Apr 2026
 * but isn't in force). This FOI document (released Jan 2024) is the best
 * available official-ish list. Treated as a `stale_register` tier and labeled
 * as such so it never reads as fresh.
 *
 * Requires `pdftotext` on PATH; fails loudly if missing or unreachable.
 */
export async function fetchAuFoiSeed(): Promise<SponsorSeed[]> {
  const buffer = await fetchSourceBuffer(AU_FOI_PDF_URL)

  // Per-attempt scratch space avoids tracing developer datasets into the
  // function and avoids collisions between concurrent collection attempts.
  const dir = await mkdtemp(join(tmpdir(), "job-search-au-"))
  const pdfPath = join(dir, "australia-sponsors.pdf")

  let stdout: string
  try {
    await writeFile(pdfPath, buffer)
    ;({ stdout } = await execFileAsync("pdftotext", [pdfPath, "-"]))
  } catch (error) {
    throw new Error(
      `Australia FOI parse needs 'pdftotext' on PATH: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }

  const seeds = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(
      (line) =>
        /PTY|LIMITED|LTD|LLP|BANK|GROUP|HOLDINGS|HOLDING|UNIVERSITY|COLLEGE|AUSTRALIA/i.test(
          line
        ) &&
        !/Freedom of Information|Released by Department|Protective Marking|Act 1982|^\d+$/.test(
          line
        )
    )
    .map<SponsorSeed>((name) => ({
      name,
      city: "Australia",
      note: "Australia accredited sponsor — STALE 2024 FOI document",
    }))

  if (seeds.length < 50) {
    throw new Error(
      `Australia FOI parse returned only ${seeds.length} companies — PDF layout likely changed`
    )
  }
  return seeds
}
