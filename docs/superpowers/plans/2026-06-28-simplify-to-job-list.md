# Simplify to a Sponsor-Job List — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Strip the relocation command center to a sponsor-job list with status tracking, a dynamic countries page that auto-fetches, one optional AI visa-signal pass, plus verified-sponsor and freshness signals.

**Architecture:** Keep the working `lib/server/sponsor-sources/**` fetch pipeline untouched (it returns `ImportPayload` of `JobLead`s). Add a thin **normalization layer** that flattens an `ImportPayload` into a new flat `Job` type and computes `freshness` + `sponsorVerified` + (optional) LLM `visaSignal`. Replace the 5,027-line monolith UI with focused components and two pages (`/jobs`, `/countries`). Delete everything else.

**Tech Stack:** Next.js (App Router, webpack, port 3002), TypeScript strict, Supabase, shadcn/ui, `node --test` + `tsx` for tests, cheerio (pipeline).

## Global Constraints

- TypeScript strict, no `any`. Functional patterns; minimal abstractions.
- Test runner: `node --import tsx --test tests/*.test.ts` (NOT jest/vitest). Test files: `tests/*.test.ts`.
- Dev server: `npm run dev` → port **3002** always.
- The pipeline fetch layer (`lib/server/sponsor-sources/**`) must NOT be modified except where this plan says so. Adapters fail loudly on source errors — keep that.
- Supported countries (the only ones addable): Netherlands, Denmark, Ireland, Japan, Australia, Germany, Sweden, UAE. `sourceId`s: `collect-<country-lowercase>`.
- LLM is best-effort only: `LLM_BASE_URL` (default `http://127.0.0.1:8317/v1`), `LLM_MODEL` (`gpt-5.5`), `LLM_API_KEY` (`local-dev-key`). Any LLM failure is silent; rule-based result stands.
- No auto-apply / auto-message / scheduled cron in v1.
- Conventional commits. No `Co-Authored-By` trailer.
- Verify after each task: relevant test file passes, then `npm run typecheck`.

---

## File Structure

**New:**
- `lib/jobs/index.ts` — the flat `Job` type, `JobStatus`, `TrackedCountry`, `SimpleAppState`, and pure helpers: `freshnessOf`, `verifyAgainstRegister`, `normalizePayload`, `mergeJobs`.
- `lib/server/visa-signal.ts` — optional LLM visa-signal refinement (best-effort).
- `app/api/ai/visa-signal/route.ts` — POST endpoint wrapping `lib/server/visa-signal.ts`.
- `components/shell/auth-gate.tsx` — magic-link / passcode gate (extracted from monolith).
- `components/jobs/jobs-page.tsx` — list + filters + refresh.
- `components/jobs/job-row.tsx` — one job row (badges + status buttons).
- `components/countries-page.tsx` — tracked list + add/remove.
- `components/add-country-picker.tsx` — picker limited to the 8 supported.
- `tests/jobs.test.ts` — unit tests for the helpers in `lib/jobs/index.ts`.

**Modified:**
- `app/page.tsx` — redirect to `/jobs`.
- `app/jobs/page.tsx`, `app/countries/page.tsx` — render the new components.
- `lib/location/relocation-data.ts` — keep only what `lib/jobs/index.ts` and countries need (`TargetCountry`, `VisaConfidence`, `CountryScore`, `targetCountries`, `visaLabels`, `makeId`, country seed data). Delete the rest.
- `app/api/sources/collect/route.ts` — keep (drives a run); only touch if it imports deleted symbols.

**Deleted:** see Task 1.

---

## Task 1: Delete the cut features

**Files:**
- Delete: `app/dashboard/`, `app/people/`, `app/drafts/`, `app/packets/`, `app/weekly/`, `app/sources/`, `app/settings/`
- Delete: `app/api/ai/discover-jobs/`, `app/api/ai/analyze-jobs/`, `app/api/ai/draft/`, `app/api/ai/tailor-resume/`, `app/api/research/`, `app/api/resume/`, `app/api/stagehand/`, `app/api/security/`, `app/api/supabase/status/`
- Delete: `lib/server/research-crawler-provider.ts`, `lib/server/research-embeddings.ts`, `lib/server/research-crawl.ts`, `lib/server/research-store.ts`, `lib/server/research-postgres.ts`, `lib/server/research-crawl-store.ts`
- Delete: `scripts/research-local-embeddings.py`, `scripts/research-playwright-crawl.mjs`

**Interfaces:**
- Produces: nothing (pure removal). Later tasks rebuild UI/state.

- [ ] **Step 1: Confirm nothing we keep imports the proxy/discovery files before deleting them**

Run: `grep -rln "research-\|/proxy/ats-discovery\|app/api/ai/\(discover\|analyze\|draft\|tailor\)\|api/research\|api/resume\|api/stagehand\|api/security" lib app components --include=*.ts --include=*.tsx | grep -v node_modules`
Expected: only files in the delete list above, plus `components/relocation-command-center.tsx` (deleted in Task 6). `lib/server/sponsor-sources/proxy/ats-discovery.ts` is still imported by `adapters.ts` (Germany/Sweden/UAE) — KEEP it.

- [ ] **Step 2: Delete the directories and files**

```bash
cd /Users/sharathreddychalla/v12labs-engineering/job-search
git rm -r app/dashboard app/people app/drafts app/packets app/weekly app/sources app/settings
git rm -r app/api/ai/discover-jobs app/api/ai/analyze-jobs app/api/ai/draft app/api/ai/tailor-resume
git rm -r app/api/research app/api/resume app/api/stagehand app/api/security app/api/supabase/status
git rm lib/server/research-crawler-provider.ts lib/server/research-embeddings.ts lib/server/research-crawl.ts lib/server/research-store.ts lib/server/research-postgres.ts lib/server/research-crawl-store.ts
git rm scripts/research-local-embeddings.py scripts/research-playwright-crawl.mjs
```

- [ ] **Step 3: Verify deletions and remaining structure**

Run: `ls app/api && ls app && ls lib/server`
Expected: `app/api` has `sources`, `state`, `ai` (only `visa-signal` will be added later — `ai` may be empty now, that's fine). `app` has `jobs`, `countries`, `page.tsx`, `layout.tsx`, `globals.css`. `lib/server` has `sponsor-sources`, `state-store.ts`, `supabase-state-store.ts` (no `research-*`).

- [ ] **Step 4: Remove empty `app/api/ai` if present and empty**

Run: `find app/api/ai -type f 2>/dev/null | head`
If no files listed: `rmdir app/api/ai 2>/dev/null || true` (it gets recreated in Task 5).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: delete dashboard, people, drafts, packets, weekly, research, AI routes"
```

Note: typecheck will FAIL after this task because the monolith still imports deleted symbols. That is expected and fixed in Task 6. Do not run typecheck as a gate here.

---

## Task 2: Define the flat `Job` model and pure helpers (types + freshness)

**Files:**
- Create: `lib/jobs/index.ts`
- Test: `tests/jobs.test.ts`

**Interfaces:**
- Consumes: `TargetCountry`, `VisaConfidence`, `CountryScore` from `@/lib/relocation-data`.
- Produces:
  - `type JobStatus = "new" | "interested" | "applied" | "dismissed"`
  - `interface Job { id: string; title: string; company: string; country: TargetCountry; city?: string; remote: "remote" | "hybrid" | "onsite" | "unknown"; url: string; visaSignal: VisaConfidence; visaSignalSource: "rules" | "llm"; visaSignalReason?: string; sponsorVerified: boolean; freshness: "fresh" | "ok" | "stale"; postedDate?: string; source: string; status: JobStatus; seenAt: string }`
  - `interface TrackedCountry { country: TargetCountry; score: CountryScore; sourceTier: "official_register" | "stale_register" | "discovery_proxy"; addedAt: string }`
  - `interface SimpleAppState { jobs: Job[]; trackedCountries: TrackedCountry[] }`
  - `function freshnessOf(postedDate: string | undefined, now: Date): Job["freshness"]`

- [ ] **Step 1: Write the failing test for `freshnessOf`**

```typescript
// tests/jobs.test.ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { freshnessOf } from "../lib/jobs"

const NOW = new Date("2026-06-28T00:00:00Z")

test("freshnessOf: <=3 days is fresh", () => {
  assert.equal(freshnessOf("2026-06-26T00:00:00Z", NOW), "fresh")
})

test("freshnessOf: 4..30 days is ok", () => {
  assert.equal(freshnessOf("2026-06-10T00:00:00Z", NOW), "ok")
})

test("freshnessOf: >30 days is stale", () => {
  assert.equal(freshnessOf("2026-04-01T00:00:00Z", NOW), "stale")
})

test("freshnessOf: missing date is stale", () => {
  assert.equal(freshnessOf(undefined, NOW), "stale")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find module `../lib/jobs` / `freshnessOf` is not a function.

- [ ] **Step 3: Write `lib/jobs/index.ts` types + `freshnessOf`**

```typescript
// lib/jobs/index.ts
import type { CountryScore, TargetCountry, VisaConfidence } from "@/lib/relocation-data"

export type JobStatus = "new" | "interested" | "applied" | "dismissed"

export interface Job {
  id: string
  title: string
  company: string
  country: TargetCountry
  city?: string
  remote: "remote" | "hybrid" | "onsite" | "unknown"
  url: string
  visaSignal: VisaConfidence
  visaSignalSource: "rules" | "llm"
  visaSignalReason?: string
  sponsorVerified: boolean
  freshness: "fresh" | "ok" | "stale"
  postedDate?: string
  source: string
  status: JobStatus
  seenAt: string
}

export interface TrackedCountry {
  country: TargetCountry
  score: CountryScore
  sourceTier: "official_register" | "stale_register" | "discovery_proxy"
  addedAt: string
}

export interface SimpleAppState {
  jobs: Job[]
  trackedCountries: TrackedCountry[]
}

const DAY_MS = 24 * 60 * 60 * 1000

export function freshnessOf(postedDate: string | undefined, now: Date): Job["freshness"] {
  if (!postedDate) return "stale"
  const posted = new Date(postedDate).getTime()
  if (Number.isNaN(posted)) return "stale"
  const ageDays = (now.getTime() - posted) / DAY_MS
  if (ageDays <= 3) return "fresh"
  if (ageDays <= 30) return "ok"
  return "stale"
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (4 freshnessOf tests).

- [ ] **Step 5: Commit**

```bash
git add lib/jobs/index.ts tests/jobs.test.ts
git commit -m "feat: add flat Job model and freshnessOf helper"
```

---

## Task 3: Sponsor verification + payload normalization

**Files:**
- Modify: `lib/jobs/index.ts`
- Test: `tests/jobs.test.ts`

**Interfaces:**
- Consumes: `Job` (Task 2); `ImportPayload`, `JobLead`, `Company` from `@/lib/relocation-data`; `makeId` from `@/lib/relocation-data`.
- Produces:
  - `function verifyAgainstRegister(company: string, registerNames: Set<string>): boolean` — case-insensitive, trimmed match.
  - `function normalizePayload(payload: ImportPayload, opts: { tier: TrackedCountry["sourceTier"]; registerNames: Set<string>; now: Date }): Job[]` — flattens `ImportPayload.jobs` (which reference companies by `companyId`) into `Job[]`. Each job: resolve `company` name from `payload.companies` by `companyId`; map `workMode` → `remote`; `visaSignal = job.visaConfidence`; `visaSignalSource = "rules"`; `sponsorVerified = tier === "official_register" && verifyAgainstRegister(companyName, registerNames)`; `freshness = freshnessOf(job.refreshedAt ?? job.createdAt, now)`; `source = job.sourceType`; `status = "new"`; `seenAt = now.toISOString()`; `id` kept from the lead.

Note on register names: `ImportPayload.companies` carry the seed company names for register sources, so `registerNames` is derived by the caller from the payload's own companies (Task 5 builds it). `normalizePayload` just consumes the set.

- [ ] **Step 1: Write failing tests for `verifyAgainstRegister` and `normalizePayload`**

```typescript
// append to tests/jobs.test.ts
import { verifyAgainstRegister, normalizePayload } from "../lib/jobs"
import type { ImportPayload } from "../lib/relocation-data"

test("verifyAgainstRegister: case-insensitive trimmed match", () => {
  const names = new Set(["acme bv", "globex"])
  assert.equal(verifyAgainstRegister("  ACME BV ", names), true)
  assert.equal(verifyAgainstRegister("Unknown Co", names), false)
})

test("normalizePayload: flattens leads, verifies sponsor, sets freshness", () => {
  const payload: ImportPayload = {
    companies: [
      { id: "c1", name: "Acme BV", country: "Netherlands", city: "Amsterdam" } as never,
    ],
    jobs: [
      {
        id: "j1",
        title: "Staff Engineer",
        companyId: "c1",
        country: "Netherlands",
        city: "Amsterdam",
        workMode: "hybrid",
        sourceUrl: "https://x/job",
        sourceType: "greenhouse",
        visaConfidence: "strong",
        refreshedAt: "2026-06-27T00:00:00Z",
        createdAt: "2026-06-27T00:00:00Z",
      } as never,
    ],
    people: [],
    drafts: [],
  } as never

  const jobs = normalizePayload(payload, {
    tier: "official_register",
    registerNames: new Set(["acme bv"]),
    now: new Date("2026-06-28T00:00:00Z"),
  })

  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].company, "Acme BV")
  assert.equal(jobs[0].remote, "hybrid")
  assert.equal(jobs[0].visaSignal, "strong")
  assert.equal(jobs[0].visaSignalSource, "rules")
  assert.equal(jobs[0].sponsorVerified, true)
  assert.equal(jobs[0].freshness, "fresh")
  assert.equal(jobs[0].status, "new")
})

test("normalizePayload: discovery tier never verifies", () => {
  const payload = {
    companies: [{ id: "c1", name: "Acme BV", country: "Germany" } as never],
    jobs: [{ id: "j1", title: "Eng", companyId: "c1", country: "Germany", workMode: "remote", sourceUrl: "u", sourceType: "arbeitnow", visaConfidence: "possible", createdAt: "2026-06-27T00:00:00Z" } as never],
    people: [], drafts: [],
  } as never
  const jobs = normalizePayload(payload, { tier: "discovery_proxy", registerNames: new Set(["acme bv"]), now: new Date("2026-06-28T00:00:00Z") })
  assert.equal(jobs[0].sponsorVerified, false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `verifyAgainstRegister`/`normalizePayload` not exported.

- [ ] **Step 3: Implement in `lib/jobs/index.ts`**

```typescript
// add imports at top of lib/jobs/index.ts
import type { Company, ImportPayload, JobLead } from "@/lib/relocation-data"

// append:
export function verifyAgainstRegister(company: string, registerNames: Set<string>): boolean {
  return registerNames.has(company.trim().toLowerCase())
}

function remoteOf(workMode: JobLead["workMode"]): Job["remote"] {
  if (workMode === "remote" || workMode === "remote_no_relocation") return "remote"
  if (workMode === "hybrid") return "hybrid"
  if (workMode === "onsite") return "onsite"
  return "unknown"
}

export function normalizePayload(
  payload: ImportPayload,
  opts: { tier: TrackedCountry["sourceTier"]; registerNames: Set<string>; now: Date },
): Job[] {
  const companyById = new Map<string, Company>(payload.companies.map((c) => [c.id, c]))
  return payload.jobs.map((lead) => {
    const companyName = companyById.get(lead.companyId)?.name ?? "Unknown company"
    return {
      id: lead.id,
      title: lead.title,
      company: companyName,
      country: lead.country,
      city: lead.city || undefined,
      remote: remoteOf(lead.workMode),
      url: lead.sourceUrl,
      visaSignal: lead.visaConfidence,
      visaSignalSource: "rules" as const,
      sponsorVerified:
        opts.tier === "official_register" && verifyAgainstRegister(companyName, opts.registerNames),
      freshness: freshnessOf(lead.refreshedAt ?? lead.createdAt, opts.now),
      postedDate: lead.refreshedAt ?? lead.createdAt,
      source: lead.sourceType,
      status: "new" as const,
      seenAt: opts.now.toISOString(),
    }
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/jobs/index.ts tests/jobs.test.ts
git commit -m "feat: normalize collection payload into flat jobs with sponsor verification"
```

---

## Task 4: Merge logic (dedup, preserve status)

**Files:**
- Modify: `lib/jobs/index.ts`
- Test: `tests/jobs.test.ts`

**Interfaces:**
- Consumes: `Job` (Task 2).
- Produces: `function mergeJobs(existing: Job[], incoming: Job[]): Job[]` — dedup by `url` (fallback key `company|title` lowercased). New jobs appended with their `status: "new"`. For a job already present (same key), keep the existing record's `status` and `seenAt` (so Applied/Dismissed stick) but refresh `freshness`, `visaSignal`, `sponsorVerified`, `postedDate` from the incoming copy.

- [ ] **Step 1: Write failing test**

```typescript
// append to tests/jobs.test.ts
import { mergeJobs } from "../lib/jobs"
import type { Job } from "../lib/jobs"

function job(over: Partial<Job>): Job {
  return {
    id: "j", title: "Eng", company: "Acme", country: "Netherlands", remote: "remote",
    url: "https://x/1", visaSignal: "possible", visaSignalSource: "rules",
    sponsorVerified: false, freshness: "ok", source: "greenhouse", status: "new",
    seenAt: "2026-06-01T00:00:00Z", ...over,
  }
}

test("mergeJobs: appends genuinely new jobs as new", () => {
  const out = mergeJobs([job({ url: "https://x/1" })], [job({ id: "j2", url: "https://x/2" })])
  assert.equal(out.length, 2)
  assert.equal(out.find((j) => j.url === "https://x/2")?.status, "new")
})

test("mergeJobs: existing job keeps its status and seenAt across refresh", () => {
  const existing = [job({ url: "https://x/1", status: "applied", seenAt: "2026-06-01T00:00:00Z", freshness: "stale" })]
  const incoming = [job({ url: "https://x/1", status: "new", seenAt: "2026-06-28T00:00:00Z", freshness: "fresh", visaSignal: "confirmed" })]
  const out = mergeJobs(existing, incoming)
  assert.equal(out.length, 1)
  assert.equal(out[0].status, "applied")
  assert.equal(out[0].seenAt, "2026-06-01T00:00:00Z")
  assert.equal(out[0].freshness, "fresh")
  assert.equal(out[0].visaSignal, "confirmed")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `mergeJobs` not exported.

- [ ] **Step 3: Implement `mergeJobs`**

```typescript
// append to lib/jobs/index.ts
function jobKey(j: Job): string {
  return j.url?.trim() ? j.url.trim().toLowerCase() : `${j.company}|${j.title}`.toLowerCase()
}

export function mergeJobs(existing: Job[], incoming: Job[]): Job[] {
  const byKey = new Map<string, Job>(existing.map((j) => [jobKey(j), j]))
  for (const inc of incoming) {
    const key = jobKey(inc)
    const prev = byKey.get(key)
    if (prev) {
      byKey.set(key, {
        ...inc,
        status: prev.status,
        seenAt: prev.seenAt,
      })
    } else {
      byKey.set(key, inc)
    }
  }
  return [...byKey.values()]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/jobs/index.ts tests/jobs.test.ts
git commit -m "feat: merge jobs preserving status across refreshes"
```

---

## Task 5: Optional LLM visa-signal refinement (best-effort)

**Files:**
- Create: `lib/server/visa-signal.ts`
- Create: `app/api/ai/visa-signal/route.ts`
- Test: `tests/jobs.test.ts` (pure helper only)

**Interfaces:**
- Consumes: `Job`, `VisaConfidence`.
- Produces:
  - `lib/server/visa-signal.ts`: `function parseVisaSignal(raw: string): { signal: VisaConfidence; reason: string } | null` (pure — parses LLM JSON, returns null on garbage) and `async function refineVisaSignals(jobs: Job[]): Promise<Job[]>` (best-effort; on any fetch error returns `jobs` unchanged).
  - `app/api/ai/visa-signal/route.ts`: `POST { jobs: Job[] } → { jobs: Job[] }` calling `refineVisaSignals`.

- [ ] **Step 1: Write failing test for `parseVisaSignal`**

```typescript
// append to tests/jobs.test.ts
import { parseVisaSignal } from "../lib/server/visa-signal"

test("parseVisaSignal: extracts signal + reason from JSON", () => {
  const out = parseVisaSignal('{"signal":"confirmed","reason":"Post says we sponsor visas"}')
  assert.deepEqual(out, { signal: "confirmed", reason: "Post says we sponsor visas" })
})

test("parseVisaSignal: returns null on garbage", () => {
  assert.equal(parseVisaSignal("not json"), null)
})

test("parseVisaSignal: returns null on invalid signal value", () => {
  assert.equal(parseVisaSignal('{"signal":"maybe","reason":"x"}'), null)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — module `../lib/server/visa-signal` not found.

- [ ] **Step 3: Implement `lib/server/visa-signal.ts`**

```typescript
// lib/server/visa-signal.ts
import type { VisaConfidence } from "@/lib/relocation-data"
import type { Job } from "@/lib/jobs"

const VALID: VisaConfidence[] = ["confirmed", "strong", "possible", "weak", "no"]

const endpoint = process.env.LLM_BASE_URL ?? "http://127.0.0.1:8317/v1"
const model = process.env.LLM_MODEL ?? "gpt-5.5"
const apiKey = process.env.LLM_API_KEY ?? "local-dev-key"

export function parseVisaSignal(raw: string): { signal: VisaConfidence; reason: string } | null {
  try {
    const start = raw.indexOf("{")
    const end = raw.lastIndexOf("}")
    if (start < 0 || end < 0) return null
    const obj = JSON.parse(raw.slice(start, end + 1)) as { signal?: string; reason?: string }
    if (!obj.signal || !VALID.includes(obj.signal as VisaConfidence)) return null
    return { signal: obj.signal as VisaConfidence, reason: String(obj.reason ?? "") }
  } catch {
    return null
  }
}

async function refineOne(job: Job): Promise<Job> {
  const prompt = `You judge visa sponsorship for a job. Reply ONLY JSON {"signal": one of ${VALID.join("|")}, "reason": short}. Title: ${job.title} at ${job.company} (${job.country}). Source: ${job.source}.`
  const res = await fetch(`${endpoint}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0 }),
  })
  if (!res.ok) return job
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
  const parsed = parseVisaSignal(data.choices?.[0]?.message?.content ?? "")
  if (!parsed) return job
  return { ...job, visaSignal: parsed.signal, visaSignalSource: "llm", visaSignalReason: parsed.reason }
}

export async function refineVisaSignals(jobs: Job[]): Promise<Job[]> {
  try {
    return await Promise.all(jobs.map((j) => refineOne(j).catch(() => j)))
  } catch {
    return jobs
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Implement the route**

```typescript
// app/api/ai/visa-signal/route.ts
import { NextResponse } from "next/server"
import type { Job } from "@/lib/jobs"
import { refineVisaSignals } from "@/lib/server/visa-signal"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { jobs?: Job[] }
  const jobs = body.jobs ?? []
  const refined = await refineVisaSignals(jobs)
  return NextResponse.json({ ok: true, jobs: refined })
}
```

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck` — Expected: this route + lib compile (monolith errors from Task 1 may still appear; that's fixed in Task 6 — just confirm no NEW errors in `lib/server/visa-signal.ts` or the new route).

```bash
git add lib/server/visa-signal.ts app/api/ai/visa-signal/route.ts tests/jobs.test.ts
git commit -m "feat: optional best-effort LLM visa-signal refinement"
```

---

## Task 6: Trim `relocation-data.ts` and replace the monolith UI

This is the big task: it removes the dead types/functions and replaces the 5,027-line component. Split into clear steps. After this task the app must typecheck.

**Files:**
- Modify: `lib/location/relocation-data.ts`
- Delete: `components/relocation-command-center.tsx`
- Create: `components/shell/auth-gate.tsx`, `components/jobs/jobs-page.tsx`, `components/jobs/job-row.tsx`, `components/countries-page.tsx`, `components/add-country-picker.tsx`
- Modify: `app/page.tsx`, `app/jobs/page.tsx`, `app/countries/page.tsx`

**Interfaces:**
- Consumes: everything from `lib/jobs/index.ts`; from `relocation-data.ts` keep `TargetCountry`, `VisaConfidence`, `CountryScore`, `targetCountries`, `visaLabels`, `makeId`, and the country seed data feeding initial `CountryScore`s.
- Produces: the running two-page UI.

- [ ] **Step 0: Verify the real field/contract names this task depends on**

Run: `grep -n "familyScore\|family\|interface CountryScore" lib/location/relocation-data.ts && echo "---" && grep -n "PUT\|POST\|GET\|writeStoredState\|export async" app/api/state/route.ts`
Record: (a) the actual family-friendliness field name on `CountryScore` (used in `countries-page.tsx` — replace `tc.score.familyScore` with the real name), and (b) whether `/api/state` already has a write handler (PUT or POST) and what body shape it expects. These two facts feed Steps 6 and 8 — do not guess them.

- [ ] **Step 1: Trim `lib/location/relocation-data.ts` to the kept surface**

Keep these exports: `TargetCountry`, `VisaConfidence`, `CountryScore`, `targetCountries`, `visaLabels`, `makeId`, and the country score seed data (the `CountryScore[]` portion of `initialState.countries`). Also keep `ImportPayload`, `JobLead`, `Company`, `SourceType` (the pipeline + `lib/jobs/index.ts` import them).

Delete these exports and their helpers: `Person`, `Draft`, `SourceConnector`, `AISearchPass`, `AISearchRun`, `AILaneOverride`, `ApplicationReadiness`, `DailyAction`, `DashboardWarning`, `SearchCommand`, `PromptTemplate`, `CandidateProfile`, `ResumeVariant`, `PipelineStatus`, `pipelineLabels`, `pipelineOrder`, `resumeVariants`, `dedupeAppState`, `mergeImportedRecordsIntoState`, `withSeedDefaults`, `scoreJob`, `scoreAllJobs`, `blendedJobRank`, `companyFor`, `applicationReadiness`, `recommendDailyActions`, `dashboardWarnings`, `buildSearchCommands`, `dueSoon`, `sourceImportPayloads`, and the now-unused fields of `AppState`/`initialState` except `countries`.

Note: `JobLead` stays (pipeline returns it) but its AI/resume fields can remain — they're just unused. Do not spend time stripping `JobLead` internals; YAGNI.

Run after editing: `npm run typecheck 2>&1 | grep "relocation-data\|sponsor-sources" | head`
Expected: no errors originating in `relocation-data.ts` or `sponsor-sources` (errors in `components/relocation-command-center.tsx` are fine — deleted next step).

- [ ] **Step 2: Delete the monolith**

```bash
git rm components/relocation-command-center.tsx
```

- [ ] **Step 3: Create `components/shell/auth-gate.tsx`**

Extract the magic-link/passcode gate. Minimal version: if `hasSupabaseConfig()` use `createBrowserSupabaseClient().auth.signInWithOtp({ email })`; else compare against `process.env.NEXT_PUBLIC_APP_PASSCODE`. Render children when authed.

```tsx
"use client"
import { useEffect, useState } from "react"
import { createBrowserSupabaseClient, hasSupabaseConfig } from "@/lib/supabase"

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [authed, setAuthed] = useState(false)
  const [email, setEmail] = useState("")
  const [pass, setPass] = useState("")
  const [sent, setSent] = useState(false)
  const passcode = process.env.NEXT_PUBLIC_APP_PASSCODE

  useEffect(() => {
    if (!hasSupabaseConfig()) return
    const supabase = createBrowserSupabaseClient()
    supabase.auth.getSession().then(({ data }) => setAuthed(!!data.session))
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setAuthed(!!s))
    return () => sub.subscription.unsubscribe()
  }, [])

  if (authed || (!hasSupabaseConfig() && passcode && pass === passcode)) return <>{children}</>

  return (
    <div className="mx-auto max-w-sm p-8 space-y-4">
      <h1 className="text-lg font-semibold">Sign in</h1>
      {hasSupabaseConfig() ? (
        sent ? (
          <p className="text-sm text-muted-foreground">Magic link sent — check your email.</p>
        ) : (
          <form
            onSubmit={async (e) => {
              e.preventDefault()
              await createBrowserSupabaseClient().auth.signInWithOtp({ email })
              setSent(true)
            }}
            className="space-y-2"
          >
            <input className="w-full border rounded px-3 py-2" type="email" placeholder="you@email.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            <button className="w-full border rounded px-3 py-2" type="submit">Send magic link</button>
          </form>
        )
      ) : (
        <input className="w-full border rounded px-3 py-2" type="password" placeholder="Passcode" value={pass} onChange={(e) => setPass(e.target.value)} />
      )}
    </div>
  )
}
```

- [ ] **Step 4: Create `components/jobs/job-row.tsx`**

```tsx
"use client"
import type { Job, JobStatus } from "@/lib/jobs"
import { visaLabels } from "@/lib/relocation-data"

const freshnessBadge: Record<Job["freshness"], string> = { fresh: "🔥 fresh", ok: "", stale: "⚠️ stale" }

export function JobRow({ job, onStatus }: { job: Job; onStatus: (id: string, s: JobStatus) => void }) {
  return (
    <div className="flex items-center justify-between border-b py-3 gap-4">
      <div className="min-w-0">
        <a href={job.url} target="_blank" rel="noreferrer" className="font-medium hover:underline truncate block">{job.title}</a>
        <div className="text-sm text-muted-foreground truncate">
          {job.company} · {job.country}{job.city ? ` · ${job.city}` : ""} · {job.remote}
        </div>
        <div className="text-xs flex gap-2 mt-1">
          <span>{visaLabels[job.visaSignal]}</span>
          {job.sponsorVerified && <span className="text-green-600">✓ verified sponsor</span>}
          {freshnessBadge[job.freshness] && <span>{freshnessBadge[job.freshness]}</span>}
        </div>
      </div>
      <div className="flex gap-1 shrink-0">
        <button className="text-xs border rounded px-2 py-1" onClick={() => onStatus(job.id, "interested")}>Interested</button>
        <button className="text-xs border rounded px-2 py-1" onClick={() => onStatus(job.id, "applied")}>Applied</button>
        <button className="text-xs border rounded px-2 py-1" onClick={() => onStatus(job.id, "dismissed")}>Dismiss</button>
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Create `components/jobs/jobs-page.tsx`**

Loads `SimpleAppState` from `/api/state`, renders filters (country, visa) + Refresh + list. Refresh: for each tracked country, POST `/api/sources/collect { sourceId }`, poll GET until `finishedAt`, normalize payload, build `registerNames` from the payload's companies when tier is `official_register`, `mergeJobs`, optionally POST `/api/ai/visa-signal`, then PUT state. Default view hides `applied`/`dismissed` (toggle).

```tsx
"use client"
import { useEffect, useMemo, useState } from "react"
import type { Job, JobStatus, SimpleAppState, TrackedCountry } from "@/lib/jobs"
import { mergeJobs, normalizePayload } from "@/lib/jobs"
import { JobRow } from "@/components/job-row"
import { targetCountries, visaLabels, type TargetCountry, type VisaConfidence, type ImportPayload } from "@/lib/relocation-data"

const FRESH_ORDER: Record<Job["freshness"], number> = { fresh: 0, ok: 1, stale: 2 }

export function JobsPage() {
  const [state, setState] = useState<SimpleAppState>({ jobs: [], trackedCountries: [] })
  const [showHidden, setShowHidden] = useState(false)
  const [country, setCountry] = useState<TargetCountry | "all">("all")
  const [visa, setVisa] = useState<VisaConfidence | "all">("all")
  const [running, setRunning] = useState(false)

  useEffect(() => {
    fetch("/api/state").then((r) => r.json()).then((d) => d?.state && setState(d.state))
  }, [])

  function persist(next: SimpleAppState) {
    setState(next)
    fetch("/api/state", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state: next }) })
  }

  function setStatus(id: string, s: JobStatus) {
    persist({ ...state, jobs: state.jobs.map((j) => (j.id === id ? { ...j, status: s } : j)) })
  }

  async function refresh() {
    setRunning(true)
    try {
      let jobs = state.jobs
      for (const tc of state.trackedCountries) {
        const payload = await runCollect(`collect-${tc.country.toLowerCase()}`)
        if (!payload) continue
        const registerNames = tc.sourceTier === "official_register"
          ? new Set(payload.companies.map((c) => c.name.trim().toLowerCase()))
          : new Set<string>()
        let incoming = normalizePayload(payload, { tier: tc.sourceTier, registerNames, now: new Date() })
        // Best-effort LLM refinement on the newly-fetched jobs only. Silent on failure.
        incoming = await refineIncoming(incoming)
        jobs = mergeJobs(jobs, incoming)
      }
      persist({ ...state, jobs })
    } finally {
      setRunning(false)
    }
  }

  const visible = useMemo(() => {
    return state.jobs
      .filter((j) => showHidden || (j.status !== "applied" && j.status !== "dismissed"))
      .filter((j) => country === "all" || j.country === country)
      .filter((j) => visa === "all" || j.visaSignal === visa)
      .sort((a, b) => FRESH_ORDER[a.freshness] - FRESH_ORDER[b.freshness])
  }, [state.jobs, showHidden, country, visa])

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="flex items-center gap-2 mb-4">
        <button className="border rounded px-3 py-1" disabled={running} onClick={refresh}>{running ? "Refreshing…" : "Refresh"}</button>
        <select className="border rounded px-2 py-1" value={country} onChange={(e) => setCountry(e.target.value as TargetCountry | "all")}>
          <option value="all">All countries</option>
          {state.trackedCountries.map((tc) => <option key={tc.country} value={tc.country}>{tc.country}</option>)}
        </select>
        <select className="border rounded px-2 py-1" value={visa} onChange={(e) => setVisa(e.target.value as VisaConfidence | "all")}>
          <option value="all">All visa signals</option>
          {Object.entries(visaLabels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <label className="text-sm ml-auto"><input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> show applied/dismissed</label>
      </div>
      {visible.length === 0 ? <p className="text-sm text-muted-foreground">No jobs yet. Add a country, then Refresh.</p> : visible.map((j) => <JobRow key={j.id} job={j} onStatus={setStatus} />)}
    </div>
  )
}

async function runCollect(sourceId: string): Promise<ImportPayload | null> {
  const start = await fetch("/api/sources/collect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceId }) }).then((r) => r.json())
  let run = start.run
  while (run && !run.finishedAt) {
    await new Promise((res) => setTimeout(res, 1500))
    run = await fetch(`/api/sources/collect?runId=${run.runId}`).then((r) => r.json()).then((d) => d.run)
  }
  return run?.payload ?? null
}

async function refineIncoming(jobs: Job[]): Promise<Job[]> {
  try {
    const res = await fetch("/api/ai/visa-signal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobs }) })
    if (!res.ok) return jobs
    const data = (await res.json()) as { jobs?: Job[] }
    return data.jobs ?? jobs
  } catch {
    return jobs
  }
}
```

(Remove the `targetCountries` import from this file if eslint flags it unused — the picker owns its own supported list.)

- [ ] **Step 6: Create `components/add-country-picker.tsx` and `components/countries-page.tsx`**

```tsx
// components/add-country-picker.tsx
"use client"
import { useState } from "react"
import type { TargetCountry } from "@/lib/relocation-data"

const SUPPORTED: TargetCountry[] = ["Netherlands", "Denmark", "Ireland", "Japan", "Australia", "Germany", "Sweden", "UAE"]

export function AddCountryPicker({ existing, onAdd }: { existing: TargetCountry[]; onAdd: (c: TargetCountry) => void }) {
  const [c, setC] = useState<TargetCountry | "">("")
  const options = SUPPORTED.filter((s) => !existing.includes(s))
  return (
    <div className="flex gap-2">
      <select className="border rounded px-2 py-1" value={c} onChange={(e) => setC(e.target.value as TargetCountry)}>
        <option value="">Add a country…</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
      <button className="border rounded px-3 py-1" disabled={!c} onClick={() => { if (c) { onAdd(c); setC("") } }}>Add</button>
    </div>
  )
}
```

```tsx
// components/countries-page.tsx
"use client"
import { useEffect, useState } from "react"
import type { SimpleAppState, TrackedCountry } from "@/lib/jobs"
import { mergeJobs, normalizePayload } from "@/lib/jobs"
import { AddCountryPicker } from "@/components/add-country-picker"
import { initialCountryScores, type TargetCountry, type ImportPayload } from "@/lib/relocation-data"

const TIER: Record<TargetCountry, TrackedCountry["sourceTier"]> = {
  Netherlands: "official_register", Denmark: "official_register", Ireland: "official_register", Japan: "official_register",
  Australia: "stale_register", Germany: "discovery_proxy", Sweden: "discovery_proxy", UAE: "discovery_proxy",
} as never

export function CountriesPage() {
  const [state, setState] = useState<SimpleAppState>({ jobs: [], trackedCountries: [] })
  useEffect(() => { fetch("/api/state").then((r) => r.json()).then((d) => d?.state && setState(d.state)) }, [])

  function persist(next: SimpleAppState) {
    setState(next)
    fetch("/api/state", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state: next }) })
  }

  async function add(country: TargetCountry) {
    const score = initialCountryScores.find((s) => s.country === country)!
    const tc: TrackedCountry = { country, score, sourceTier: TIER[country], addedAt: new Date().toISOString() }
    const withCountry = { ...state, trackedCountries: [...state.trackedCountries, tc] }
    persist(withCountry)
    const payload = await runCollect(`collect-${country.toLowerCase()}`)
    if (!payload) return
    const registerNames = tc.sourceTier === "official_register" ? new Set(payload.companies.map((c) => c.name.trim().toLowerCase())) : new Set<string>()
    const incoming = normalizePayload(payload, { tier: tc.sourceTier, registerNames, now: new Date() })
    persist({ ...withCountry, jobs: mergeJobs(withCountry.jobs, incoming) })
  }

  function remove(country: TargetCountry) {
    persist({ ...state, trackedCountries: state.trackedCountries.filter((t) => t.country !== country) })
  }

  return (
    <div className="mx-auto max-w-2xl p-6 space-y-4">
      <AddCountryPicker existing={state.trackedCountries.map((t) => t.country)} onAdd={add} />
      <ul className="space-y-2">
        {state.trackedCountries.map((tc) => (
          <li key={tc.country} className="flex items-center justify-between border rounded px-3 py-2">
            <span>{tc.country} · family score {tc.score.familyScore ?? "—"} · <span className="text-xs text-muted-foreground">{tc.sourceTier.replace("_", " ")}</span></span>
            <button className="text-xs border rounded px-2 py-1" onClick={() => remove(tc.country)}>Remove</button>
          </li>
        ))}
      </ul>
    </div>
  )
}

async function runCollect(sourceId: string): Promise<ImportPayload | null> {
  const start = await fetch("/api/sources/collect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceId }) }).then((r) => r.json())
  let run = start.run
  while (run && !run.finishedAt) { await new Promise((res) => setTimeout(res, 1500)); run = await fetch(`/api/sources/collect?runId=${run.runId}`).then((r) => r.json()).then((d) => d.run) }
  return run?.payload ?? null
}
```

Note: Step 1 must export `initialCountryScores: CountryScore[]` (rename/extract from the old `initialState.countries`) and ensure `CountryScore` has the `familyScore` field actually used here — if the field is named differently, use the real name. Verify the field name in `relocation-data.ts` before writing this component.

- [ ] **Step 7: Wire the pages**

```tsx
// app/page.tsx
import { redirect } from "next/navigation"
export default function Home() { redirect("/jobs") }
```

```tsx
// app/jobs/page.tsx
import { AuthGate } from "@/components/auth-gate"
import { JobsPage } from "@/components/jobs-page"
export default function Page() { return <AuthGate><JobsPage /></AuthGate> }
```

```tsx
// app/countries/page.tsx
import { AuthGate } from "@/components/auth-gate"
import { CountriesPage } from "@/components/countries-page"
export default function Page() { return <AuthGate><CountriesPage /></AuthGate> }
```

- [ ] **Step 8: Confirm `/api/state` PUT exists and accepts `{ state }`**

Run: `grep -n "PUT\|writeStoredState\|state" app/api/state/route.ts | head`
Expected: a `PUT`/`POST` handler that persists the posted state. If it only supports `GET`, add a `PUT` that calls `writeStoredState(body.state)` and returns `{ ok: true }`. The store accepts `AppState`; `SimpleAppState` is a structural subset for persistence purposes (jobs + trackedCountries) — if `writeStoredState` is strictly typed to the old `AppState`, change its param type to `Partial<AppState> & SimpleAppState` or a new `StoredState` union. Keep it minimal.

- [ ] **Step 9: Typecheck (must pass now)**

Run: `npm run typecheck`
Expected: PASS (zero errors). Fix any remaining references to deleted symbols.

- [ ] **Step 10: Lint + full test run**

Run: `npm run lint && npm test`
Expected: lint clean, all tests pass.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat: replace monolith with jobs + countries pages and auth gate"
```

---

## Task 7: Build + manual smoke + README trim

**Files:**
- Modify: `README.md`

**Interfaces:** none.

- [ ] **Step 1: Production build**

Run: `npm run build`
Expected: build succeeds. Fix any build-only errors (e.g. server/client boundary).

- [ ] **Step 2: Manual smoke**

Run: `npm run dev` then open `http://localhost:3002`.
Verify: redirected to `/jobs`; sign-in gate renders; on `/countries` adding "Netherlands" kicks off a run and (after it finishes) jobs appear on `/jobs`; status buttons hide applied/dismissed; freshness/verified badges show.

- [ ] **Step 3: Trim `README.md`**

Replace the "Built So Far" and feature sections to describe only: jobs list with status tracking, dynamic countries page (add → auto-fetch), verified-sponsor + freshness badges, optional LLM visa-signal, magic-link auth. Remove drafts/packets/people/research/Stagehand mentions. Note ghost-job detection + scheduled auto-refresh as future ideas.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: trim README to the simplified app"
```

---

## Notes for the implementer

- **Verify field names before writing UI:** `CountryScore`'s family-score field and `/api/state`'s persistence contract are referenced in Task 6 — read the real definitions first; the plan flags both.
- **The pipeline is the fetcher; don't reinvent it.** `runSponsorCollection(sourceId)` → `ImportPayload`. The collect route already runs it async with polling. We only consume its output.
- **LLM is never required.** Every LLM path must degrade to rule-based silently.
- **Fast-follows (not in this plan):** ghost-job detection (reposting cadence, careers-page absence, description-dup), scheduled cron auto-refresh.
