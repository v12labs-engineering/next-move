# Simplify to a Sponsor-Job List — Design

Date: 2026-06-28

## Goal

Strip the relocation command center down to its one real job: **automatically find new
jobs that offer visa sponsorship, and let me track which ones I've acted on.**

Everything that does not serve that goal is deleted. The current app has 14 pages, ~16 API
routes, a research/embeddings/crawl pipeline, Stagehand discovery, AI drafting, people/drafts/
packets tracking, and a single 5,027-line UI component. After this change it has two pages, a
handful of routes, and a focused UI.

## What the app becomes

A private, magic-link-protected app with **two screens**:

### 1. Jobs (the main screen)

- A **Refresh** button at the top that runs the existing feeds + sponsor-register collection
  and merges new jobs into the list (skipping ones already seen).
- Filters: country, visa signal.
- A list of jobs. Each row shows: title, company, country, city, remote/onsite, visa-signal
  badge, a "✓ verified sponsor" badge when `sponsorVerified`, a freshness badge
  (🔥 fresh / ⚠️ stale), posted date, and an apply link.
- Within each country, jobs sort fresh-first.
- Three per-row status actions: **Interested / Applied / Dismiss**.
- Default view hides `dismissed` and `applied`. A toggle reveals them.

### 2. Countries (active control surface)

The countries page is **not** a static reference — it drives the fetch. Adding a country
turns its sponsor source on and pulls jobs for it.

- A list of the countries the user is tracking, each showing its family-friendliness score
  and a source-tier badge (official register / stale register / ATS discovery) so the user
  knows how trustworthy that country's source is.
- An **Add country** picker, limited to the 8 countries that have a real sponsor adapter:
  Netherlands, Denmark, Ireland, Japan, Australia, Germany, Sweden, UAE. No free-text /
  unsupported countries — nothing dead can be added.
- Adding a country: persists it to the tracked set, then immediately kicks off that country's
  collection run (its `sourceId`, e.g. `collect-netherlands`) and merges the results into the
  Jobs list. The new country's jobs appear on the Jobs screen automatically.
- Removing a country: drops it from the tracked set. Its already-fetched jobs stay in the list
  unless the user dismisses them (we don't silently delete history).
- Refresh on the Jobs screen runs collection for **all tracked countries**, not a fixed set.

The 8 supported countries and their adapter `sourceId`s already exist in
`lib/server/sponsor-sources/adapters.ts` (`sponsorAdapters`). Tiers are honest: NL/DK/IE/JP are
official registers, AU is a stale 2024 FOI list, DE/SE/UAE are ATS discovery (no register).

### Auth

- Keep Supabase magic-link sign-in so the app can be deployed privately and shared with a
  friend. Extract it from the monolith into a small auth gate component that wraps the two
  pages. Local passcode fallback stays as-is.

## Data model (reduced)

```ts
type JobStatus = "new" | "interested" | "applied" | "dismissed"

interface Job {
  id: string
  title: string
  company: string
  country: TargetCountry
  city?: string
  remote: "remote" | "hybrid" | "onsite" | "unknown"
  url: string
  visaSignal: VisaConfidence   // confirmed | strong | possible | weak | no
  visaSignalSource: "rules" | "llm"
  visaSignalReason?: string    // one-line LLM reason, when llm
  sponsorVerified: boolean     // employer name matches an official_register source
  freshness: "fresh" | "ok" | "stale"  // derived from postedDate
  postedDate?: string
  source: string
  status: JobStatus
  seenAt: string
}

interface TrackedCountry {
  country: TargetCountry       // one of the 8 supported
  score: CountryScore          // family-friendliness reference data
  sourceTier: "official_register" | "stale_register" | "discovery_proxy"
  addedAt: string
}

interface AppState {
  jobs: Job[]
  trackedCountries: TrackedCountry[]   // drives which sources Refresh runs
}
```

`JobLead`'s extra fields (resume variant, follow-up date, application date, score, role type,
seniority, notes) are dropped. `Company`, `Person`, `Draft`, `SourceConnector`, `AISearchRun`,
`PromptTemplate`, `CandidateProfile`, `ApplicationReadiness`, `DailyAction`, `DashboardWarning`
and related types are deleted.

## AI: one feature only — visa-signal refinement

The app keeps exactly **one** AI ability, and it serves the core goal directly: judging whether
a job actually offers sponsorship.

- The existing rule-based classifier (`classify.ts`) always runs first and is the source of
  truth when AI is unavailable.
- When cliproxy is reachable, an **optional LLM second pass** reads the job title + description
  and returns a refined `visaSignal` (confirmed / strong / possible / weak / no) plus a one-line
  reason. This catches phrasing the keyword rules miss ("we sponsor work visas", "must already
  have the right to work in X").
- **Not a hard dependency.** If `LLM_BASE_URL` is unreachable or errors, the job keeps its
  rule-based signal and the app works exactly the same. No blocking, no crash.
- Wiring reuses the existing OpenAI-compatible config: `LLM_BASE_URL`
  (default `http://127.0.0.1:8317/v1`), `LLM_MODEL` (default `gpt-5.5`), `LLM_API_KEY`
  (default `local-dev-key`). One small route — e.g. `app/api/ai/visa-signal` — replaces the
  four deleted AI routes.
- Runs as part of the merge step on newly-fetched jobs only (not re-run on every refresh), to
  keep it cheap. Each job stores `visaSignalSource: "rules" | "llm"` so the UI can show which.

Everything else AI-related (job discovery, scoring, outreach drafting, resume tailoring, resume
parsing, research embeddings/RAG) is deleted.

## Two signal enrichments (from 2026 market research)

These are cheap, rule-based derivations computed during the merge step — no new dependencies.
They directly serve the goal (find *real* sponsor jobs worth applying to early).

**1. Sponsor verification (`sponsorVerified`).** Most job boards only keyword-match "we sponsor".
We already fetch official government sponsor *registers* (IND ~12k names, SIRI, JETRO, etc.),
and each register seed carries the real employer name. When a fetched job's company name matches
a name from an `official_register`-tier source, mark `sponsorVerified: true` — a genuinely
verified sponsor, not a guess. Surfaced as a distinct "✓ verified sponsor" badge, stronger than
any `visaSignal`. (Names from `stale_register`/`discovery_proxy` sources do NOT verify.)

**2. Freshness (`freshness`).** 2026 conversion data: applying within ~3 days of posting
strongly beats late applies, and stale evergreen reposts are the top ghost-job signal. Derive
from `postedDate`: `fresh` (≤3 days), `ok` (≤30 days), `stale` (>30 days or no date). Shown as a
badge; the list sorts fresh-first within a country. Pure date math, no AI.

A third research finding — full **ghost-job detection** (reposting cadence, careers-page absence,
description-dup, entry-title/senior-reqs mismatch) — is a documented fast-follow, not in v1.
`freshness` already captures the single strongest ghost signal (staleness).

## What stays

- `lib/server/sponsor-sources/**` — the working feeds + per-country sponsor registers. This is
  the fetcher. ~1,200 EU jobs keyless in ~15s; per-country adapters for NL/DE/IE/SE/DK/JP/AU/UAE.
- `lib/supabase.ts` + Supabase persistence — but persisting only `jobs` and `countries`.
- Dedup/merge logic in `relocation-data.ts`, trimmed to the reduced model.
- The `/api/sources/collect` route (drives a collection run), trimmed if it references deleted
  concepts.
- `/api/state`, `/api/state/export`, `/api/state/import` — kept for persistence/backup.
- The country score data already in `relocation-data.ts`.

## What gets deleted

Pages: `dashboard`, `people`, `drafts`, `packets`, `weekly`, `sources`, `settings`.
(`jobs` and `countries` stay; `app/page.tsx` redirects to `/jobs`.)

Routes: `app/api/ai/{discover-jobs,analyze-jobs,draft,tailor-resume}`, `app/api/research/*`,
`app/api/resume/*`, `app/api/stagehand`, `app/api/security`, `app/api/supabase/status`.
(A new `app/api/ai/visa-signal` route is the only AI route that survives — see the AI section.)

Lib: `lib/server/research-*`, `lib/server/sponsor-sources/proxy/*` if only used by
research/Stagehand discovery (verify before deleting).

Scripts: `scripts/research-local-embeddings.py`, `scripts/research-playwright-crawl.mjs`.

Types/data: Drafts, People, Packets, ResumeVariant, AI-search, prompt templates, candidate
profile, dashboard actions/warnings.

The 5,027-line `relocation-command-center.tsx` is replaced by focused components:
`auth-gate.tsx`, `jobs-page.tsx` (list + filters + refresh), `job-row.tsx`,
`countries-page.tsx` (tracked list + add/remove), `add-country-picker.tsx`. Each is small and
single-purpose.

## The "automatic" part

v1 is manual **Refresh** (chosen: keep the feeds pipeline, run it on demand). Scheduled
auto-run is a documented fast-follow: a Vercel cron hitting the collect route on a schedule,
~10 lines. Not built in v1.

## Fetch flows

There are two triggers; both share the same merge logic.

**Add a country** (from the Countries page):
1. User picks a supported country and confirms.
2. It's added to `trackedCountries` (with its score + source tier).
3. Its collection run starts immediately (the country's `sourceId`).
4. Returned jobs are merged (see merge logic). The Jobs screen now shows that country's jobs.

**Refresh** (from the Jobs page):
1. User clicks Refresh.
2. Collection runs for **every tracked country**.
3. All returned jobs are merged.

**Merge logic (shared):**
- Normalize returned jobs to the `Job` shape; visa signal comes from the rule-based classifier
  (`visaSignalSource: "rules"`).
- Dedup by URL (fall back to company+title).
- New jobs get `status: "new"`, `seenAt: now`.
- Compute `freshness` from `postedDate` (date math) and `sponsorVerified` by matching the
  company name against names from `official_register`-tier sources collected this run.
- For **new** jobs only, if cliproxy is reachable, run the optional LLM visa-signal pass to
  refine `visaSignal` (sets `visaSignalSource: "llm"` + `visaSignalReason`). Failure is silent —
  the rule-based signal stands.
- Existing jobs keep their status (Applied/Dismissed stick across refreshes).
- Persist to Supabase (or local fallback). List re-renders, new jobs at top.

## Error handling

- A source that fails during a run is skipped; the run reports which sources errored, others
  still merge. (Reuse existing per-source run handling.)
- If Supabase is unconfigured, fall back to local state file (existing behavior).
- If cliproxy/LLM is unreachable or errors, jobs keep their rule-based visa signal; no failure
  surfaces to the user. The LLM pass is best-effort only.
- Refresh shows a clear running/done/error state.

## Testing

- Unit: merge/dedup keeps existing status and only marks genuinely-new jobs as `new`.
- Unit: status transitions (new→interested→applied, →dismissed) and the default-view filter.
- Unit: adding a country appends to `trackedCountries` and the picker only offers the 8
  supported; removing a country leaves its jobs intact.
- Integration: Refresh against a stubbed feeds result produces the expected merged list.
- Integration: adding a country triggers exactly that country's collection run and merges it.
- Unit: when the LLM pass is stubbed to fail, new jobs retain their rule-based `visaSignal` and
  `visaSignalSource` stays `"rules"`; when it succeeds, signal + source + reason update.
- Unit: `freshness` buckets correctly (≤3d fresh, ≤30d ok, >30d/none stale).
- Unit: `sponsorVerified` is true only when company name matches an `official_register` source,
  false for `stale_register`/`discovery_proxy` matches.
- Behavior, not implementation. Run single files during dev per repo conventions.

## Out of scope (v1)

Auto-applying, auto-messaging, AI drafting, resume tailoring, AI job discovery, AI scoring,
people/contact tracking, outreach drafts, application packets, weekly review, research
crawl/embeddings, Stagehand discovery, scheduled auto-refresh. (The only AI kept is visa-signal
refinement, above.)

## Finishing criteria

- Open the app, sign in via magic link (or passcode fallback).
- See a list of sponsor-friendly jobs; click Refresh to pull new ones for all tracked countries.
- On the Countries page, add a supported country and have its jobs fetched automatically and
  appear in the Jobs list without any extra step.
- Remove a tracked country; its already-fetched jobs remain until dismissed.
- Filter by country and visa signal.
- Mark a job Interested / Applied / Dismiss; dismissed/applied drop off the default view and
  stay that way across refreshes.
- `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` all pass.
