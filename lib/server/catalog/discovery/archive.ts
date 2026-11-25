import { createHash } from "node:crypto"
import { z } from "zod"
import { boardFromUrl } from "../source-identity"
import { readBounded, type SourceCandidate } from "./seeds"

// Archive indexes discover employer addresses, never current jobs. Keep these
// partitions aligned with collectors: regional Lever/Greenhouse are not aliases.
export const archivePartitions = {
  ashby: { host: "jobs.ashbyhq.com", matchType: "host" },
  greenhouse: { host: "job-boards.greenhouse.io", matchType: "host" },
  "greenhouse-legacy": { host: "boards.greenhouse.io", matchType: "host" },
  lever: { host: "jobs.lever.co", matchType: "host" },
  smartrecruiters: { host: "jobs.smartrecruiters.com", matchType: "host" },
  "smartrecruiters-careers": {
    host: "careers.smartrecruiters.com",
    matchType: "host",
  },
  workday: { host: "myworkdayjobs.com", matchType: "domain" },
  recruitee: { host: "recruitee.com", matchType: "domain" },
  workable: { host: "apply.workable.com", matchType: "host" },
  teamtailor: { host: "teamtailor.com", matchType: "domain" },
  "personio-de": { host: "jobs.personio.de", matchType: "domain" },
  "personio-com": { host: "jobs.personio.com", matchType: "domain" },
} as const
const partitionSchema = z.enum(
  Object.keys(archivePartitions) as [
    keyof typeof archivePartitions,
    ...Array<keyof typeof archivePartitions>,
  ]
)
const indexSchema = z.string().regex(/^CC-MAIN-20\d{2}-\d{2}$/)
export const archiveCursorSchema = z.object({
  index: indexSchema,
  partition: partitionSchema,
  page: z.number().int().min(0).max(1_000_000),
})
export type ArchiveCursor = z.infer<typeof archiveCursorSchema>
const captureSchema = z.object({
  url: z.string().max(16_000),
  timestamp: z.string().regex(/^\d{14}$/),
  status: z.string(),
})
const maxBytes = 2_000_000

export class ArchiveHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAt: string | null
  ) {
    super(`Archive HTTP ${status}; retry the same cursor later`)
  }
}

function archiveHttpFailure(response: Response) {
  const header = response.headers.get("retry-after")
  const retry =
    header && /^\d+$/.test(header)
      ? Date.now() + Number(header) * 1000
      : Date.parse(header ?? "")
  return new ArchiveHttpError(
    response.status,
    Number.isFinite(retry)
      ? new Date(
          Math.min(Date.now() + 86400000, Math.max(Date.now() + 60000, retry))
        ).toISOString()
      : null
  )
}

export async function latestArchiveIndex(transport: typeof fetch = fetch) {
  const response = await transport(
    "https://index.commoncrawl.org/collinfo.json",
    {
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
      headers: {
        "User-Agent": "JobSearchCatalog/1.0",
        Accept: "application/json",
      },
    }
  )
  if (!response.ok) {
    await response.body?.cancel()
    throw archiveHttpFailure(response)
  }
  const collections = z
    .array(z.object({ id: z.string() }))
    .min(1)
    .parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await readBounded(response, 200_000)
        )
      )
    )
  return indexSchema.parse(
    collections
      .map((entry) => entry.id)
      .filter((id) => indexSchema.safeParse(id).success)
      .sort()
      .at(-1)
  )
}

export function archiveResume(value: unknown, apply: boolean): ArchiveCursor {
  const receipt = z
    .object({
      command: z.literal("archive"),
      applied: z.boolean(),
      nextCursor: archiveCursorSchema.nullable(),
    })
    .parse(value)
  if (apply && !receipt.applied)
    throw new Error("Apply the previewed page before resuming its cursor")
  if (!receipt.nextCursor) throw new Error("Archive partition is complete")
  return receipt.nextCursor
}

export function parseArchivePage(text: string, cursor: ArchiveCursor) {
  archiveCursorSchema.parse(cursor)
  if (Buffer.byteLength(text) > maxBytes)
    throw new Error("Archive page exceeds size limit")
  const lines = text.split(/\r?\n/).filter((line) => line.trim())
  if (lines.length > 5_000) throw new Error("Archive page exceeds row limit")
  const candidates = new Map<string, SourceCandidate>()
  const partition = archivePartitions[cursor.partition]
  let rejected = 0
  for (const line of lines) {
    // A corrupt/truncated page fails as a whole so its cursor cannot skip rows.
    const capture = captureSchema.parse(JSON.parse(line))
    let url: URL
    try {
      url = new URL(capture.url)
    } catch {
      rejected++
      continue
    }
    const inPartition =
      partition.matchType === "domain"
        ? url.hostname.endsWith(`.${partition.host}`)
        : url.hostname === partition.host
    const identity =
      inPartition && capture.status === "200" ? boardFromUrl(capture.url) : null
    if (!identity) {
      rejected++
      continue
    }
    if (!candidates.has(identity.id))
      candidates.set(identity.id, {
        ...identity,
        expected_company: null,
        // An archive capture is neither a live validation nor a posting date.
        historical_checked_at: null,
        evidence_url: capture.url,
      })
  }
  return { candidates: [...candidates.values()], rows: lines.length, rejected }
}

/** Read one complete compressed index block. No per-row limit: truncating a
 * block then advancing page would permanently skip employer candidates. */
export async function discoverArchivePage(
  input: { partition: string; index?: string; page?: number },
  options: { fetch?: typeof fetch } = {}
) {
  const partition = partitionSchema.parse(input.partition)
  const page = archiveCursorSchema.shape.page.parse(input.page ?? 0)
  let index =
    input.index === undefined ? undefined : indexSchema.parse(input.index)
  if (!index && page !== 0)
    throw new Error("Continuation requires a pinned archive index")
  const transport = options.fetch ?? fetch
  const signal = AbortSignal.timeout(60_000)
  async function read(url: string, limit: number) {
    const response = await transport(url, {
      redirect: "error",
      cache: "no-store",
      headers: {
        "User-Agent": "JobSearchCatalog/1.0",
        Accept: "application/json",
      },
      signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]),
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw archiveHttpFailure(response)
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(
      await readBounded(response, limit)
    )
  }
  if (!index) {
    index = await latestArchiveIndex(transport)
  }
  const cursor = { index, partition, page }
  const query = archivePartitions[partition]
  const url = new URL(`https://index.commoncrawl.org/${index}-index`)
  url.search = new URLSearchParams({
    url: query.host,
    matchType: query.matchType,
    output: "json",
    fl: "url,timestamp,status",
    filter: "=status:200",
    pageSize: "1",
    showNumPages: "true",
  }).toString()
  const pagination = z
    .object({
      pages: z.number().int().min(0).max(1_000_000),
      pageSize: z.literal(1),
    })
    .parse(JSON.parse(await read(url.href, 10_000)))
  if (page >= pagination.pages && !(page === 0 && pagination.pages === 0))
    throw new Error("Archive page is outside the collection")
  url.searchParams.delete("showNumPages")
  url.searchParams.set("page", String(page))
  const body = pagination.pages ? await read(url.href, maxBytes) : ""
  const parsed = parseArchivePage(body, cursor)
  const sha256 = createHash("sha256").update(body).digest("hex")
  const revision = createHash("sha1")
    .update(JSON.stringify({ cursor, sha256 }))
    .digest("hex")
  return {
    cursor,
    nextCursor:
      page + 1 < pagination.pages ? { ...cursor, page: page + 1 } : null,
    totalPages: pagination.pages,
    ...parsed,
    origin: {
      id: `common-crawl:${revision}`,
      format: "common-crawl",
      revision,
      sha256,
      license: "not-established",
      attribution: "Common Crawl URL index",
      attributionUrl: "https://commoncrawl.org/cdxj-index",
      cursor,
      queryUrl: url.href,
      note: "Historical URL evidence only. Capture timestamps are not posting dates. Live employer validation and collection are required; no content reuse permission inferred.",
    },
  }
}
