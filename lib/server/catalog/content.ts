import { matchingMetric } from "../matching/metrics"
import { createHash } from "node:crypto"
import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib"
import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"

export const CATALOG_CONTENT_BUCKET = "job-catalog-content-v1"
const MAX_PACK_BYTES = 512 * 1024
const MAX_TEXT_BYTES = 240_000
const CACHE_BYTES = 24 * 1024 * 1024
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex")
export const descriptionRefSchema = z
  .object({
    v: z.literal(1),
    pack: z.string().regex(/^[a-f0-9]{64}$/),
    offset: z.number().int().min(0).max(MAX_PACK_BYTES),
    length: z.number().int().min(1).max(MAX_PACK_BYTES),
    bytes: z.number().int().min(1).max(MAX_TEXT_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .refine((ref) => ref.offset + ref.length <= MAX_PACK_BYTES)
export type DescriptionRef = z.infer<typeof descriptionRefSchema>
type DescriptionRow = {
  id?: string
  description: string
  description_ref?: DescriptionRef | null
}

export function packDescriptions(rows: { id: string; description: string }[]) {
  const packs: {
    id: string
    body: Buffer
    refs: Map<string, DescriptionRef>
  }[] = []
  let parts: Buffer[] = [],
    size = 0
  let pending: {
    id: string
    offset: number
    length: number
    bytes: number
    sha256: string
  }[] = []
  function finish() {
    if (!parts.length) return
    const body = Buffer.concat(parts),
      id = hash(body)
    const refs = new Map(
      pending.map(({ id: rowId, ...ref }) => [
        rowId,
        { ...ref, v: 1 as const, pack: id },
      ])
    )
    packs.push({ id, body, refs })
    parts = []
    pending = []
    size = 0
  }
  for (const row of rows) {
    if (!row.description) continue
    const input = Buffer.from(row.description)
    if (input.length > MAX_TEXT_BYTES)
      throw new Error("Job description exceeds archive limit")
    const body = brotliCompressSync(input, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 6 },
    })
    if (size + body.length > MAX_PACK_BYTES || parts.length >= 128) finish()
    pending.push({
      id: row.id,
      offset: size,
      length: body.length,
      bytes: input.length,
      sha256: hash(input),
    })
    parts.push(body)
    size += body.length
  }
  finish()
  return packs
}

export function unpackDescription(
  input: Uint8Array,
  reference: DescriptionRef
) {
  const ref = descriptionRefSchema.parse(reference)
  if (input.byteLength !== ref.length)
    throw new Error("Job description archive is truncated")
  const body = brotliDecompressSync(input, { maxOutputLength: MAX_TEXT_BYTES })
  if (body.length !== ref.bytes || hash(body) !== ref.sha256)
    throw new Error("Job description checksum mismatch")
  return new TextDecoder("utf-8", { fatal: true }).decode(body)
}

async function boundedBytes(response: Response, maximum: number) {
  if (!response.body) throw new Error("Job description archive is unavailable")
  const reader = response.body.getReader(),
    parts: Uint8Array[] = []
  let bytes = 0
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    bytes += next.value.length
    if (bytes > maximum) {
      await reader.cancel()
      throw new Error("Job description archive exceeded its limit")
    }
    parts.push(next.value)
  }
  return Buffer.concat(parts)
}

const textCache = new Map<string, string>()
const rangeReads = new Map<string, Promise<Buffer>>()
let cachedBytes = 0
function cacheText(key: string, text: string) {
  if (textCache.has(key)) return
  const bytes = Buffer.byteLength(text)
  while (cachedBytes + bytes > CACHE_BYTES && textCache.size) {
    const first = textCache.entries().next().value!
    textCache.delete(first[0])
    cachedBytes -= Buffer.byteLength(first[1])
  }
  textCache.set(key, text)
  cachedBytes += bytes
}

/** Storage layout stays private to this module; callers receive original text. */
export async function hydrateCatalogDescriptions<T extends DescriptionRow>(
  db: SupabaseClient,
  rows: T[],
  fetcher: typeof fetch = fetch
): Promise<(T & { description_ref?: DescriptionRef | null })[]> {
  const result = rows.map((row) => ({ ...row }))
  const missing: { row: T; ref: DescriptionRef }[] = []
  for (const row of result) {
    if (!row.description_ref) continue
    const ref = descriptionRefSchema.parse(row.description_ref)
    const cached = textCache.get(ref.sha256)
    if (cached !== undefined) row.description = cached
    else missing.push({ row, ref })
  }
  // Coalesce adjacent blocks in the same immutable pack. Each request stays
  // below 128 KiB; sparse references never force a whole-pack download.
  const groups: {
    url: string
    start: number
    end: number
    items: typeof missing
  }[] = []
  const ordered = [...missing].sort(
    (a, b) =>
      a.ref.pack.localeCompare(b.ref.pack) || a.ref.offset - b.ref.offset
  )
  for (const item of ordered) {
    const { data } = db.storage
      .from(CATALOG_CONTENT_BUCKET)
      .getPublicUrl(`v1/${item.ref.pack}.bin`)
    const end = item.ref.offset + item.ref.length - 1
    const previous = groups.at(-1)
    if (
      previous &&
      previous.url === data.publicUrl &&
      item.ref.offset <= previous.end + 1025 &&
      end - previous.start < 128 * 1024
    ) {
      previous.end = Math.max(previous.end, end)
      previous.items.push(item)
    } else
      groups.push({
        url: data.publicUrl,
        start: item.ref.offset,
        end,
        items: [item],
      })
  }
  let index = 0,
    requests = 0,
    transferredBytes = 0
  await Promise.all(
    Array.from({ length: Math.min(8, groups.length) }, async () => {
      for (let group = groups[index++]; group; group = groups[index++]) {
        const key = `${group.url}:${group.start}:${group.end}`
        let pending = rangeReads.get(key)
        if (!pending) {
          const current = group
          pending = (async () => {
            requests++
            const response = await fetcher(current.url, {
              headers: { Range: `bytes=${current.start}-${current.end}` },
              redirect: "error",
              signal: AbortSignal.timeout(15_000),
            })
            const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
              response.headers.get("content-range") ?? ""
            )
            if (
              response.status !== 206 ||
              !range ||
              Number(range[1]) !== current.start ||
              Number(range[2]) !== current.end ||
              Number(range[3]) <= current.end ||
              Number(range[3]) > MAX_PACK_BYTES
            )
              throw new Error(
                "Job description archive did not return the requested range"
              )
            const bytes = await boundedBytes(
              response,
              current.end - current.start + 1
            )
            if (bytes.length !== current.end - current.start + 1)
              throw new Error("Job description archive is truncated")
            transferredBytes += bytes.length
            return bytes
          })()
          rangeReads.set(key, pending)
        }
        try {
          const bytes = await pending
          for (const item of group.items) {
            const offset = item.ref.offset - group.start
            const text = unpackDescription(
              bytes.subarray(offset, offset + item.ref.length),
              item.ref
            )
            item.row.description = text
            cacheText(item.ref.sha256, text)
          }
        } finally {
          if (rangeReads.get(key) === pending) rangeReads.delete(key)
        }
      }
    })
  )
  matchingMetric("storage", {
    requests,
    transferredBytes,
    descriptions: missing.length,
    cacheHits: rows.length - missing.length,
  })
  return result
}

export async function ensureCatalogContentBucket(db: SupabaseClient) {
  const bucket = await db.storage.getBucket(CATALOG_CONTENT_BUCKET)
  if (bucket.error) {
    if (!["404", "400"].includes(String(bucket.error.statusCode)))
      throw bucket.error
    const created = await db.storage.createBucket(CATALOG_CONTENT_BUCKET, {
      public: true,
      fileSizeLimit: MAX_PACK_BYTES,
      allowedMimeTypes: ["application/octet-stream"],
    })
    if (
      created.error &&
      !["409", "400"].includes(String(created.error.statusCode))
    )
      throw created.error
    const confirmed = await db.storage.getBucket(CATALOG_CONTENT_BUCKET)
    if (confirmed.error || confirmed.data?.public !== true)
      throw new Error("Public job description bucket is unavailable")
  } else if (bucket.data.public !== true)
    throw new Error("Job description bucket configuration differs")
}

/** Upload + readback verification always precedes any database text removal. */
export async function archiveCatalogDescriptions<
  T extends DescriptionRow & { id: string },
>(
  db: SupabaseClient,
  rows: T[]
): Promise<(T & { description_ref?: DescriptionRef | null })[]> {
  const result = rows.map((row) => ({ ...row }))
  const pending: T[] = []
  for (const row of result) {
    if (row.description_ref) {
      const ref = descriptionRefSchema.parse(row.description_ref)
      if (
        !row.description ||
        hash(Buffer.from(row.description)) === ref.sha256
      ) {
        row.description = ""
        continue
      }
    }
    if (row.description) pending.push(row)
  }
  if (!pending.length) return result
  await ensureCatalogContentBucket(db)
  const ids = pending.map((row) => row.id)
  const reusable = new Map<string, DescriptionRef>()
  for (let start = 0; start < ids.length; start += 100) {
    const current = await db
      .from("job_catalog")
      .select("id,description_ref")
      .in("id", ids.slice(start, start + 100))
    if (current.error) throw current.error
    for (const row of current.data)
      if (row.description_ref)
        reusable.set(row.id, descriptionRefSchema.parse(row.description_ref))
  }
  const fresh = pending.filter((row) => {
    const ref = reusable.get(row.id)
    if (ref && ref.sha256 === hash(Buffer.from(row.description))) {
      row.description_ref = ref
      row.description = ""
      return false
    }
    return true
  })
  for (const pack of packDescriptions(fresh)) {
    const reserved = await db.rpc("reserve_catalog_content", {
      p_id: pack.id,
      p_bytes: pack.body.length,
    })
    if (reserved.error) throw reserved.error
    const uploaded = await db.storage
      .from(CATALOG_CONTENT_BUCKET)
      .upload(`v1/${pack.id}.bin`, pack.body, {
        contentType: "application/octet-stream",
        cacheControl: "31536000",
        upsert: false,
      })
    if (
      uploaded.error &&
      !["400", "409"].includes(String(uploaded.error.statusCode))
    )
      throw uploaded.error
    const downloaded = await db.storage
      .from(CATALOG_CONTENT_BUCKET)
      .download(`v1/${pack.id}.bin`)
    if (downloaded.error) throw downloaded.error
    const bytes = Buffer.from(await downloaded.data.arrayBuffer())
    if (bytes.length !== pack.body.length || hash(bytes) !== pack.id)
      throw new Error("Job description upload verification failed")
    for (const [id, ref] of pack.refs) {
      const row = fresh.find((item) => item.id === id)!
      if (
        unpackDescription(
          bytes.subarray(ref.offset, ref.offset + ref.length),
          ref
        ) !== row.description
      )
        throw new Error("Job description roundtrip failed")
    }
    const ready = await db.rpc("confirm_catalog_content", {
      p_id: pack.id,
      p_bytes: bytes.length,
    })
    if (ready.error) throw ready.error
    for (const [id, ref] of pack.refs) {
      const row = result.find((item) => item.id === id)!
      row.description_ref = ref
      row.description = ""
    }
  }
  return result
}
