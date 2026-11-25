import { boardKinds } from "../source-identity"
import type { SupabaseClient } from "@supabase/supabase-js"
import { supabaseServerClient } from "../../supabase-server"
import { type SeedDirectory, type SourceCandidate } from "./seeds"
import {
  probeClient,
  validateCandidate,
  type ValidationResult,
} from "./validate"

export class CandidateStore {
  constructor(readonly db: SupabaseClient = supabaseServerClient()) {}

  async import(
    directory: Pick<
      SeedDirectory,
      "id" | "revision" | "sha256" | "license" | "attribution"
    > &
      Record<string, unknown>,
    candidates: SourceCandidate[]
  ) {
    let added = 0,
      observations = 0
    for (let offset = 0; offset < candidates.length; offset += 500) {
      const result = await this.db.rpc("import_source_candidates", {
        p_origin: directory,
        p_candidates: candidates.slice(offset, offset + 500),
      })
      if (result.error) throw result.error
      added += result.data.new_candidates
      observations += result.data.new_observations
    }
    return { newCandidates: added, newObservations: observations }
  }

  async list(options: {
    limit: number
    ids?: string[]
    status?: string
    after?: string
    kind?: string
    validatedAfter?: string
  }) {
    let query = this.db
      .from("source_candidates")
      .select("*")
      .order("validated_at", { nullsFirst: true })
      .order("next_attempt_at")
      .order("id")
      .limit(options.limit)
    if (options.ids?.length) query = query.in("id", options.ids)
    if (options.kind) query = query.eq("kind", options.kind)
    if (options.validatedAfter)
      query = query.gte("validated_at", options.validatedAfter)
    if (options.status) query = query.eq("status", options.status)
    else {
      query = query.not("status", "in", "(activated,invalid)")
      if (!options.ids?.length)
        query = query
          .lte("next_attempt_at", new Date().toISOString())
          .or(`lease_until.is.null,lease_until.lte.${new Date().toISOString()}`)
    }
    if (options.after) query = query.gt("id", options.after)
    const result = await query
    if (result.error) throw result.error
    return result.data as (SourceCandidate & {
      status: string
      validation: ValidationResult | null
      validated_at: string | null
    })[]
  }

  async validate(options: {
    limit: number
    ids?: string[]
    apply: boolean
    recheck?: boolean
    maxMs?: number
    candidateMs?: number
    requireRecent?: boolean
  }) {
    const candidates = options.ids?.length
      ? await this.list(options)
      : await this.fairBatch(options.limit)
    const notFound = (options.ids ?? []).filter(
      (id) => !candidates.some((candidate) => candidate.id === id)
    )
    const read = probeClient()
    const results: {
      id: string
      result?: ValidationResult
      skipped?: string
    }[] = []
    const deadline = Date.now() + (options.maxMs ?? 300_000)
    const candidateMs = options.candidateMs ?? 25_000
    for (const candidate of candidates) {
      if (Date.now() > deadline - candidateMs - 1_000) break
      let token: string | undefined
      if (options.apply) {
        const reviewable =
          ["needs_review", "missing", "empty", "verified"].includes(
            candidate.status
          ) ||
          (candidate.status === "deferred" &&
            /^Provider HTTP 40[13]$/.test(candidate.validation?.reason ?? ""))
        if (options.recheck && reviewable) {
          const retry = await this.db
            .from("source_candidates")
            .update({ next_attempt_at: new Date().toISOString() })
            .eq("id", candidate.id)
            .eq("status", candidate.status)
            .is("lease_token", null)
          if (retry.error) throw retry.error
        }
        const claimed = await this.db.rpc("claim_source_candidate", {
          p_id: candidate.id,
        })
        if (claimed.error) throw claimed.error
        if (!claimed.data) {
          results.push({ id: candidate.id, skipped: "Not due or claimed" })
          continue
        }
        token = claimed.data.token
      }
      let result = await validateCandidate(
        candidate,
        read,
        new Date(),
        AbortSignal.timeout(candidateMs)
      )
      if (
        options.requireRecent &&
        result.status === "verified" &&
        !result.fresh_count
      )
        result = {
          ...result,
          status: "needs_review",
          reason:
            "Sample lacks dated software postings in the collection window",
        }
      if (token) {
        const saved = await this.db.rpc("finish_source_candidate", {
          p_id: candidate.id,
          p_token: token,
          p_result: result,
        })
        if (saved.error) throw saved.error
      }
      results.push({ id: candidate.id, result })
      // One source at a time, with a pause independent of cached robots checks.
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    return {
      selected: candidates.length,
      processed: results.length,
      complete: results.length === candidates.length && notFound.length === 0,
      notFound,
      results,
    }
  }

  async fairBatch(limit: number, now = Date.now()) {
    // A bounded run may not reach every provider. Rotate its first provider
    // each six-hour cycle while giving never-validated candidates priority.
    const start = Math.floor(now / (6 * 3600000)) % boardKinds.length
    const kinds = [...boardKinds.slice(start), ...boardKinds.slice(0, start)]
    const queues = await Promise.all(
      kinds.map((kind) => this.list({ limit, kind }))
    )
    const candidates = []
    for (let offset = 0; candidates.length < limit; offset++) {
      let added = false
      for (const queue of queues) {
        if (queue[offset] && candidates.length < limit) {
          candidates.push(queue[offset])
          added = true
        }
      }
      if (!added) break
    }
    return candidates
  }

  async expand(options: {
    limit: number
    apply: boolean
    maxMs?: number
    force?: boolean
    requireRecent?: boolean
  }) {
    if (process.env.APP_ENV !== "staging")
      throw new Error(
        "Automatic source activation is currently scoped to isolated staging"
      )
    let batchId: string | null = null
    if (options.apply) {
      const claim = await this.db.rpc("claim_source_expansion", {
        p_force: options.force ?? false,
      })
      if (claim.error) throw claim.error
      batchId = claim.data
      if (!batchId)
        return {
          skipped: "A batch is leased or ran within the last hour",
          activatedSources: [],
        }
    }
    try {
      const validation = await this.validate({
        ...options,
        candidateMs: 15_000,
        maxMs: options.maxMs ?? 240_000,
      })
      // Recover successful validations interrupted before activation as well.
      const pending = await this.list({
        limit: options.limit,
        status: "verified",
        validatedAfter: new Date(Date.now() - 86400000).toISOString(),
      })
      const fresh = pending.filter(
        (candidate) =>
          candidate.validated_at &&
          Date.parse(candidate.validated_at) > Date.now() - 86400000 &&
          (!options.requireRecent ||
            (candidate.validation?.fresh_count ?? 0) > 0)
      )
      const ids = options.apply
        ? fresh.map((candidate) => candidate.id)
        : validation.results
            .filter((row) => row.result?.status === "verified")
            .map((row) => row.id)
      const activated = options.apply
        ? await this.activate(
            ids,
            "Automatic isolated-staging expansion authorized by the operator: live provider identity and usable public posting evidence passed; directory provenance retained. Commercial launch source-use review remains separate."
          )
        : []
      const counts: Record<string, number> = {}
      for (const row of validation.results) {
        const status = row.result?.status ?? "skipped"
        counts[status] = (counts[status] ?? 0) + 1
      }
      const report = {
        batchId,
        selected: validation.selected,
        processed: validation.processed,
        complete: validation.complete,
        counts,
        activatedSources: activated.map((source) => source.id),
        wouldActivate: options.apply ? [] : ids,
      }
      if (batchId) {
        const finished = await this.db.rpc("finish_source_expansion", {
          p_id: batchId,
          p_result: report,
          p_failed: false,
        })
        if (finished.error) throw finished.error
      }
      return report
    } catch (error) {
      if (batchId)
        await this.db.rpc("finish_source_expansion", {
          p_id: batchId,
          p_result: { error: "Batch interrupted; candidate progress retained" },
          p_failed: true,
        })
      throw error
    }
  }

  async activate(ids: string[], note: string) {
    const sources = []
    for (const id of ids) {
      const result = await this.db.rpc("activate_source_candidate", {
        p_id: id,
        p_note: note,
      })
      if (result.error) throw result.error
      sources.push(result.data)
    }
    return sources
  }
}
