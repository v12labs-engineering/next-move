# Real Sponsor → Jobs Pipeline

Replace hardcoded source fixtures with a real, live pipeline that, per target country:

1. fetch official sponsor source (or proxy where none exists)
2. filter to software/tech companies (heuristic)
3. resolve website + careers page
4. crawl careers page for real job posts (via existing `crawlPage`)
5. build Company/JobLead records and score them

## Decisions

- Execution: background run triggered from the app source button; poll status.
- Tech filter: heuristic now (name + domain signals), LLM later.
- Coverage: ALL 8 target countries.
- No-register countries (DE/SE/UAE): ATS/job-board discovery, visaSignal capped at `possible`.
- Failure: **fail loudly, no fallback**. If an official source is unreachable or its layout changed, that country's run errors and returns nothing. Never present stale data as fresh.

## Country source tiers (verified live 2026-06-25)

| Country | Source | Tier |
|---|---|---|
| Netherlands | IND public register (ind.nl) static HTML ~3000 | A real register |
| Denmark | SIRI fast-track certified (nyidanmark.dk) static HTML ~1000 | A real register |
| Ireland | Employment permits XLSX (enterprise.gov.ie) | A real register |
| Japan | JETRO Open-for-Professionals (jetro.go.jp) paginated HTML ~283 | A real list |
| Australia | FOI PDF 2024 (home affairs); no live register yet | B stale seed |
| Germany | no register → ATS/job-board discovery | C proxy |
| Sweden | no register → ATS/job-board discovery | C proxy |
| UAE | no register → ATS/job-board discovery | C proxy |

## Architecture

```
lib/server/sponsor-sources/
  types.ts          SponsorSeed, SponsorAdapter, CollectionRun
  classify.ts       isSoftwareCompany(name, website?) heuristic + tests
  enrich.ts         resolveWebsite / resolveCareersUrl (via crawlPage)
  extract-jobs.ts   extractJobsFromCareers(careersUrl) via crawlPage + ATS detect
  registers/
    netherlands.ts  fetchIndSponsors()
    denmark.ts      fetchSiriCertified()
    ireland.ts      fetchIrelandPermits()
    japan.ts        fetchJetroOfp()
    australia.ts    fetchAuFoiSeed()  (stale-labeled)
  proxy/
    ats-discovery.ts  discoverViaAts(country)  (DE/SE/UAE)
  pipeline.ts       runSponsorCollection(country) -> ImportPayload
lib/server/sponsor-run-store.ts   persist run progress/results
app/api/sources/collect/route.ts  POST start async run, GET status
```

## Build order

- [ ] Core types + heuristic classifier (+ unit tests)
- [ ] enrich + extract-jobs on top of crawlPage (+ tests w/ fixtures)
- [ ] Tier A registers: NL, DK, IE, JP (verify each live)
- [ ] Tier B: AU FOI seed (stale-labeled)
- [ ] Tier C: ATS discovery for DE/SE/UAE
- [ ] pipeline.ts orchestrator + run store
- [ ] /api/sources/collect route (async + status)
- [ ] Wire app source buttons to real collect
- [ ] Verify end-to-end live; show real counts
