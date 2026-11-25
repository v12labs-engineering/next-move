import { createHash } from "node:crypto"

import {
  boardIdentity,
  boardKind,
  publicBoardUrl,
  type BoardKind,
} from "../source-identity"
export {
  boardIdentity,
  boardKind,
  publicBoardUrl,
  type BoardKind,
} from "../source-identity"

const openRevision = "01b3908c8a8fe13bb4117cd2b2f7e2c7d489a108"
const roundRevision = "2816bfadd65b7bbec23701dd036bcc7496c729db"
export const seedDirectories = [
  ...(["greenhouse", "ashby", "lever"] as const).map((kind, i) => ({
    id: `open-ats-feed:${kind}:${openRevision}`,
    format: "open-ats-feed" as const,
    kind,
    revision: openRevision,
    url: `https://raw.githubusercontent.com/veresk06/open-ats-feed/${openRevision}/docs/data/${kind}.csv`,
    sha256: [
      "92e20db1359bb1e9f1b8d9729c708b35d8fa6d398e6909c36b57fdc2a5a39a18",
      "a47f6ed699467733d01d5648b4b6a22cb11554674194d0d431ee63e3e81aa559",
      "0199a8ecb1ed541499ca7f58289da740ce3a4a92575bb56cfb48ce5631a06126",
    ][i],
    license: "MIT",
    attribution: "Open ATS Feed contributors",
    attributionUrl: `https://github.com/veresk06/open-ats-feed/blob/${openRevision}/LICENSE`,
    snapshotDate: "2026-09-05",
  })),
  {
    id: `lastround:${roundRevision}`,
    format: "lastround" as const,
    kind: null,
    revision: roundRevision,
    url: `https://raw.githubusercontent.com/fyrosofttech/lastroundai-hiring-data/${roundRevision}/ats-directory/lastroundai-ats-company-directory-2026-08.csv`,
    sha256: "e637a04d06561bb3839dbf95a291e5fd11ac26b8f2858dc207939c1b723974a3",
    license: "CC-BY-4.0",
    attribution: "LastRound AI",
    attributionUrl:
      "https://lastroundai.com/blog/salary-transparency-study-2026",
    snapshotDate: "2026-08-01",
  },
  {
    id: `open-ats-feed:teamtailor:${openRevision}`,
    format: "open-ats-feed" as const,
    kind: "teamtailor",
    revision: openRevision,
    url: `https://raw.githubusercontent.com/veresk06/open-ats-feed/${openRevision}/docs/data/teamtailor.csv`,
    sha256: "ef1c4a35f861ba67740585e8d401cebeb6f47982d350ddbd8047213abfcc3e4e",
    license: "MIT",
    attribution: "Open ATS Feed contributors",
    attributionUrl: `https://github.com/veresk06/open-ats-feed/blob/${openRevision}/LICENSE`,
    snapshotDate: "2026-09-05",
  },
  {
    id: `open-ats-feed:recruitee:${openRevision}`,
    format: "open-ats-feed" as const,
    kind: "recruitee",
    revision: openRevision,
    url: `https://raw.githubusercontent.com/veresk06/open-ats-feed/${openRevision}/docs/data/recruitee.csv`,
    sha256: "0af6d43fc0645df5239cd804b62a223bb89a190197550cecafa8308366bfddfe",
    license: "MIT",
    attribution: "Open ATS Feed contributors",
    attributionUrl: `https://github.com/veresk06/open-ats-feed/blob/${openRevision}/LICENSE`,
    snapshotDate: "2026-09-05",
  },
] as const
export type SeedDirectory = (typeof seedDirectories)[number]
export interface SourceCandidate {
  id: string
  kind: BoardKind
  board: string
  expected_company: string | null
  historical_checked_at: string | null
  evidence_url: string
}

// RFC 4180 field quoting, including escaped quotes, CRLF and quoted newlines.
// A malformed file fails as a whole instead of silently losing candidate rows.
export function csvRows(text: string): string[][] {
  if (Buffer.byteLength(text) > 2_000_000)
    throw new Error("Directory is too large")
  const rows: string[][] = []
  let row: string[] = [],
    field = "",
    quoted = false,
    closed = false
  text = text.replace(/^\uFEFF/, "")
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          quoted = false
          closed = true
        }
      } else field += char
    } else if (char === "," || char === "\n" || char === "\r") {
      row.push(field)
      field = ""
      closed = false
      if (char !== ",") {
        if (char === "\r" && text[i + 1] === "\n") i++
        if (row.some(Boolean)) rows.push(row)
        row = []
      }
    } else if (char === '"' && !field && !closed) quoted = true
    else {
      if (closed || char === '"') throw new Error("Malformed CSV quoting")
      field += char
    }
  }
  if (quoted) throw new Error("Unterminated CSV field")
  if (field || row.length || closed) {
    row.push(field)
    rows.push(row)
  }
  if (rows.length > 30_001) throw new Error("Directory row limit exceeded")
  return rows
}

export function parseDirectory(directory: SeedDirectory, text: string) {
  const [header, ...rows] = csvRows(text)
  const expected =
    directory.format === "lastround"
      ? ["ats_vendor", "company_name", "board_slug", "last_crawled"]
      : ["provider", "token", "open_postings", "board_url", "api_url"]
  if (JSON.stringify(header) !== JSON.stringify(expected))
    throw new Error("Unexpected directory schema")
  const candidates = rows.map((values): SourceCandidate => {
    if (values.length !== expected.length) throw new Error("Malformed CSV row")
    const record = Object.fromEntries(
      expected.map((key, i) => [key, values[i]])
    )
    const kind = boardKind.parse(record.ats_vendor ?? record.provider)
    if (directory.kind && directory.kind !== kind)
      throw new Error("Provider mismatch")
    // The pinned Teamtailor directory uses tenant slugs. Our canonical source
    // identity retains the full host; never derive it from the API URL field.
    const value = record.board_slug ?? record.token
    const identity = boardIdentity(
      kind,
      kind === "teamtailor" && directory.format === "open-ats-feed"
        ? `${value}.teamtailor.com`
        : value
    )
    // A Git revision date is not evidence of when a particular board was checked.
    const date = directory.format === "lastround" ? record.last_crawled : null
    if (
      (directory.format === "lastround" && !date) ||
      (date &&
        (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
          new Date(date).toISOString().slice(0, 10) !== date ||
          date > directory.snapshotDate))
    )
      throw new Error("Invalid historical observation date")
    const company = record.company_name?.replace(/\s+/g, " ").trim() || null
    if (company && company.length > 300)
      throw new Error("Company label is too long")
    // These directory URLs are evidence only; network requests are reconstructed
    // from the allowlisted provider and validated token, never taken from CSV.
    const evidence = publicBoardUrl(kind, identity.board)
    if (record.board_url) {
      const url = new URL(record.board_url)
      const hosts =
        kind === "greenhouse"
          ? ["boards.greenhouse.io", "job-boards.greenhouse.io"]
          : [new URL(evidence).hostname]
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.port ||
        !hosts.includes(url.hostname) ||
        (kind === "teamtailor" || kind === "recruitee"
          ? !["", "/"].includes(url.pathname) || Boolean(url.search || url.hash)
          : url.pathname.split("/")[1]?.toLowerCase() !== identity.board)
      )
        throw new Error("Directory board URL does not match its identity")
    }
    return {
      ...identity,
      expected_company: company,
      historical_checked_at: date,
      evidence_url: evidence,
    }
  })
  return {
    candidates,
    rows: rows.length,
    distinctSources: new Set(candidates.map((c) => c.id)).size,
  }
}

export async function readBounded(response: Response, limit: number) {
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel()
    throw new Error("Response size limit exceeded")
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error("Response has no body")
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) throw new Error("Response size limit exceeded")
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return Buffer.concat(chunks)
}

export async function downloadDirectory(
  directory: SeedDirectory,
  transport: typeof fetch = fetch
) {
  const response = await transport(directory.url, {
    redirect: "error",
    cache: "no-store",
    headers: { "User-Agent": "JobSearchCatalog/1.0", Accept: "text/csv" },
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`Directory HTTP ${response.status}`)
  }
  const bytes = await readBounded(response, 2_000_000)
  if (createHash("sha256").update(bytes).digest("hex") !== directory.sha256)
    throw new Error("Pinned directory checksum mismatch")
  return parseDirectory(
    directory,
    new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  )
}
