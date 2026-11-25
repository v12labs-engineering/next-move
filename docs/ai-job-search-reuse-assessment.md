# Reuse assessment: ai-job-search-dev/ai-job-search

Assessed 2026-10-30 by reading upstream documentation, repository tree and selected implementation files through GitHub. Snapshot: [`83c788d779b74522bb346145ef675b984bf2d3f7`](https://github.com/ai-job-search-dev/ai-job-search/commit/83c788d779b74522bb346145ef675b984bf2d3f7), the observed `master` head (committed 2026-10-27). No upstream code was executed, dependencies installed, live portal tested, or product code changed.

## Decision

Use this repository as a source of selected adapters, document-quality tooling and workflow ideas. Its architecture is a personal Claude Code workspace, so importing the whole project would not replace an account-based web product cleanly. It stores a candidate profile in Markdown, application state in CSV/JSON and generated files on disk; its portal integrations are Bun CLIs, and its automation is largely agent command instructions. This is visible in its [repository layout and usage documentation](https://github.com/ai-job-search-dev/ai-job-search/blob/83c788d779b74522bb346145ef675b984bf2d3f7/README.md), [scraper workflow](https://github.com/ai-job-search-dev/ai-job-search/blob/83c788d779b74522bb346145ef675b984bf2d3f7/.claude/skills/job-scraper/SKILL.md) and [apply command](https://github.com/ai-job-search-dev/ai-job-search/blob/83c788d779b74522bb346145ef675b984bf2d3f7/.claude/commands/apply.md).

The upstream [MIT license](https://github.com/ai-job-search-dev/ai-job-search/blob/83c788d779b74522bb346145ef675b984bf2d3f7/LICENSE) permits copying, modification and commercial use, with its copyright and permission notice retained in copies or substantial portions. This license applies to upstream software; it does not establish permission to collect or redistribute third-party job-board content. Bundled fonts or external dependencies would need their own notice review if copied.

## Best candidates, in priority order

| Priority | Candidate | What is actually present | Proposed use |
| --- | --- | --- | --- |
| 1 | Freehire source adapter | TypeScript HTTP search/detail implementation, facet filters, normalized fields and offline test files. | Evaluate as an additional tech-job source, then adapt its mapping to the existing catalogue contract. Measure relevant coverage before enabling. |
| 2 | Requirement and preference evaluation | Language and eligibility gates, weighted skills/experience/career criteria, strengths and gaps. These are agent instructions, not a deployable matching service. | Translate selected rules into explicit, evidence-backed fields and visible explanations. Keep candidate-confirmed preferences and unknown values. |
| 3 | PDF quality checks | Executable Python helpers for page count, extractable text, date encoding and geometry-based layout checks. | Reuse or port when adding PDF resumes; verify rendered output as well as the text employers can parse. |
| 4 | Untrusted posting hygiene | Executable HTML/invisible-text cleaner and suspicious-content findings, with dedicated tests. | Adapt useful sanitization checks before a description is supplied to an AI model. Keep the posting as data regardless of cleaner verdict. |
| 5 | Portal health and provenance | Agent workflow specifies source mechanism, posting dates, bounded sentinel probes and separate rate-limit states. | Add missing diagnostics to existing source operations only where they improve current measurements. |
| 6 | Application package quality | Requirement coverage, claim grounding, role-specific cover letters and bounded-length form answers. | Use as design guidance for future reviewed document/answer generation rather than replacing the application worker. |

### 1. Freehire: strongest concrete supply candidate

The [search implementation](https://github.com/ai-job-search-dev/ai-job-search/blob/83c788d779b74522bb346145ef675b984bf2d3f7/.agents/skills/freehire-search/cli/src/commands/search.ts) calls `/api/v1/agent/jobs/search` for full descriptions and `/api/v1/jobs/search` in lean mode, with country/city/region, skills, seniority, category, work-mode and posting-age parameters. The [helpers](https://github.com/ai-job-search-dev/ai-job-search/blob/83c788d779b74522bb346145ef675b984bf2d3f7/.agents/skills/freehire-search/cli/src/helpers.ts) normalize IDs, original employer URLs, dates, locations, descriptions and detail enrichment. The [package manifest](https://github.com/ai-job-search-dev/ai-job-search/blob/83c788d779b74522bb346145ef675b984bf2d3f7/.agents/skills/freehire-search/cli/package.json) has no runtime dependencies.

The helper also implements 15-second request timeouts, bounded retry waits and `Retry-After` handling. In our server collector those waits should become durable deferred work, using the existing backoff/checkpoint machinery, rather than sleeping inside a request. Response interfaces are TypeScript types rather than runtime schemas; integration should validate untrusted JSON before publication. Source regions and countries remain evidence supplied by an aggregator and need normalization and location checks. [Implementation](https://github.com/ai-job-search-dev/ai-job-search/blob/83c788d779b74522bb346145ef675b984bf2d3f7/.agents/skills/freehire-search/cli/src/helpers.ts).

The upstream [Freehire skill documentation](https://github.com/ai-job-search-dev/ai-job-search/blob/83c788d779b74522bb346145ef675b984bf2d3f7/.agents/skills/freehire-search/SKILL.md) explicitly describes tech-first filtering and a best-effort hosted service with no SLA. Its approximate ATS count is an upstream claim, not measured worldwide or non-tech coverage. Neither API availability, current catalogue size, India/Hyderabad supply, source-content rights nor suitability for our commercial ingestion cadence was verified in this assessment.

Recommendation: first perform a bounded read-only API evaluation and verify service/content-use terms, then add a disabled source with fixtures and measured coverage. Keep the original employer apply URL and separate source provenance; only enable after review.

### 2. Matching: useful rubric, selective adoption

The [evaluation framework](https://github.com/ai-job-search-dev/ai-job-search/blob/83c788d779b74522bb346145ef675b984bf2d3f7/.claude/skills/job-application-assistant/04-job-evaluation.md) distinguishes:

- Required working language from the language in which the advert is written.
- A missing declared language (FAIL) from a possibly insufficient level in a declared language (FLAG).
- Role eligibility from permit timing and employer-wide welcome statements.
- Skills and experience from candidate career goals and tasks they prefer.

These distinctions can improve explanations beyond keyword overlap. The weights (30% skills, 25% experience, 15% behavioral fit, 30% career alignment) are authored heuristics, not empirically validated probabilities. Do not present them as interview-success estimates. [Rubric and weights](https://github.com/ai-job-search-dev/ai-job-search/blob/83c788d779b74522bb346145ef675b984bf2d3f7/.claude/skills/job-application-assistant/04-job-evaluation.md).

Do not copy country-specific legal assumptions or template defaults blindly. For example, its clearance eligibility discussion and relocation-as-fail default are inappropriate as universal rules. Our relocation use case should retain relocation support. An absent profile language or work-rights field remains unknown, rather than proving inability; generic visa-holder welcome text is not confirmation that this role accepts the candidate's exact status. Use explicit role-level posting evidence, candidate-confirmed facts and country-specific verification where needed. Keep employer culture and motivation unknown when evidence is absent. [Gate and logistics instructions](https://github.com/ai-job-search-dev/ai-job-search/blob/83c788d779b74522bb346145ef675b984bf2d3f7/.claude/skills/job-application-assistant/04-job-evaluation.md).

### 3. Resume quality: actual reusable helpers

[`verify_pdf.py`](https://github.com/ai-job-search-dev/ai-job-search/blob/83c788d779b74522bb346145ef675b984bf2d3f7/tools/verify_pdf.py) extracts text through optional pypdf or Poppler, checks expected pages and required text, and detects Unicode-dash date ranges. Its dump target is intentionally tied to upstream `cv/` and `cover_letters/` folders; this constraint must be redesigned for account-owned temporary artifacts.

[`verify_layout.py`](https://github.com/ai-job-search-dev/ai-job-search/blob/83c788d779b74522bb346145ef675b984bf2d3f7/tools/verify_layout.py) uses Poppler word bounding boxes for gaps, early page endings, footer collisions and stranded headings. It reports unavailable extraction separately. Thresholds are explicitly calibrated for upstream moderncv/cover.cls geometry, so they need fixture calibration for any chosen web-product template.

The [apply workflow](https://github.com/ai-job-search-dev/ai-job-search/blob/83c788d779b74522bb346145ef675b984bf2d3f7/.claude/commands/apply.md) adds compile/render/visual inspection, extracted-text inspection and a requirement-coverage table separating supported missing keywords from real skill gaps. This workflow is valuable guidance; it is not proof that every generated document passes those checks or that any particular ATS will parse it correctly.

### 4. Posting integrity: useful defense with limits

[`posting_guard.py`](https://github.com/ai-job-search-dev/ai-job-search/blob/83c788d779b74522bb346145ef675b984bf2d3f7/tools/posting_guard.py) removes hidden HTML and invisible characters and reports instruction-shaped lines, hidden URLs and mixed-script lookalikes. Its [tests](https://github.com/ai-job-search-dev/ai-job-search/blob/83c788d779b74522bb346145ef675b984bf2d3f7/tests/test_posting_guard.py) include calibration against legitimate role text as well as adversarial examples.

This is a deterministic hygiene layer, not a prompt-injection guarantee. Its own documentation says findings advise rather than block; visible malicious instructions can survive cleaning, and benign multilingual text needs careful handling. Preserve strict tool/URL boundaries and avoid reintroducing removed payload excerpts into future prompts. [Implementation and limits](https://github.com/ai-job-search-dev/ai-job-search/blob/83c788d779b74522bb346145ef675b984bf2d3f7/tools/posting_guard.py).

### 5. Operations: borrow any missing diagnostics

The [scraper workflow](https://github.com/ai-job-search-dev/ai-job-search/blob/83c788d779b74522bb346145ef675b984bf2d3f7/.claude/skills/job-scraper/SKILL.md) records `cli` versus `websearch` provenance and original posting date separately from first-seen date. It specifies bounded sentinel queries when a portal unexpectedly yields nothing, with 429/blocking treated as inconclusive rather than parser breakage. These are useful operational ideas, but are instructions for an agent; they are not a server scheduler implementation.

Mass-posting consolidation is also specified there. For our destination-based matching, duplicate consolidation must retain reviewable country/city variants; an upstream one-row presentation rule is not sufficient as an ingestion identity rule. [Scraper deduplication instructions](https://github.com/ai-job-search-dev/ai-job-search/blob/83c788d779b74522bb346145ef675b984bf2d3f7/.claude/skills/job-scraper/SKILL.md).

### 6. Application flow: guidance rather than replacement

The [apply command](https://github.com/ai-job-search-dev/ai-job-search/blob/83c788d779b74522bb346145ef675b984bf2d3f7/.claude/commands/apply.md) creates CV/cover-letter artifacts and records a `drafted` tracker state. It points to a later outcome command for recording actual submission. The [application forms instructions](https://github.com/ai-job-search-dev/ai-job-search/blob/83c788d779b74522bb346145ef675b984bf2d3f7/.claude/skills/job-application-assistant/08-application-forms.md) describe text the candidate pastes into a portal, with measured character/word limits and factual grounding.

This is useful for richer application packets, interview preparation and cover letters. It is not an implemented universal ATS submission engine and does not replace our durable Browserbase worker, answer continuation, duplicate-send controls or receipt requirement. Any future rewriting would require a separate product decision and stronger evidence validation than free-form agent instructions.

## What to avoid importing

- **Whole Claude runtime/configuration:** Markdown profiles, local files, CSV/JSON state and pre-approved desktop commands do not supply SaaS account isolation or durable server jobs. [Architecture](https://github.com/ai-job-search-dev/ai-job-search/blob/83c788d779b74522bb346145ef675b984bf2d3f7/README.md).
- **LinkedIn scraping as a hosted commercial source:** its own skill warns automated access is against LinkedIn terms and says personal use only, not commercial or bulk collection. This is the upstream's stated restriction; no independent legal conclusion is asserted here. [Warning](https://github.com/ai-job-search-dev/ai-job-search/blob/83c788d779b74522bb346145ef675b984bf2d3f7/.agents/skills/linkedin-search/SKILL.md).
- **Automatic activation of regional scrapers:** four shipped portals target Denmark, so their existence does not solve worldwide supply. [Portal inventory](https://github.com/ai-job-search-dev/ai-job-search/blob/83c788d779b74522bb346145ef675b984bf2d3f7/README.md).
- **Raw prompt rubrics as enforcement:** eligibility, factual grounding and review instructions require explicit application validation if adopted. [Evaluation](https://github.com/ai-job-search-dev/ai-job-search/blob/83c788d779b74522bb346145ef675b984bf2d3f7/.claude/skills/job-application-assistant/04-job-evaluation.md), [apply](https://github.com/ai-job-search-dev/ai-job-search/blob/83c788d779b74522bb346145ef675b984bf2d3f7/.claude/commands/apply.md).
- **Bundled salary data assumptions:** the salary tooling expects user-provided data and skips when absent; it is not a live global compensation dataset. [Salary documentation](https://github.com/ai-job-search-dev/ai-job-search/blob/83c788d779b74522bb346145ef675b984bf2d3f7/tools/README_SALARY_TOOL.md).

## Verification and remaining uncertainty

### Fit with this checkout

The local comparison used the current working tree, including existing uncommitted application-runner changes; their presence does not establish deployment:

- [`lib/server/catalog/feeds.ts`](../lib/server/catalog/feeds.ts), [`directory.ts`](../lib/server/catalog/directory.ts) and [`sync.ts`](../lib/server/catalog/sync.ts) already provide structured ATS feeds, disabled discovered boards, source prioritization and durable collection checkpoints/backoff. Freehire would need an adapter within that contract, with explicit partial-search semantics; a search result page cannot be treated as a complete source snapshot for expiry.
- [`lib/matching/index.ts`](../lib/matching/index.ts) already explains profession, location, work-mode, experience and sponsorship matches. Declared working languages and career preferences are the clearest additional evaluation ideas; upstream heuristic scores should not replace existing eligibility boundaries.
- [`lib/server/tailoring/index.ts`](../lib/server/tailoring/index.ts) and [`lib/resume/index.ts`](../lib/resume/index.ts) select and validate verbatim resume evidence. The current product exports DOCX; upstream PDF/LaTeX helpers become directly relevant only if a PDF export path is added.
- [`lib/server/applications/worker.ts`](../lib/server/applications/worker.ts), [`forms.ts`](../lib/server/applications/forms.ts) and [`lib/applications/index.ts`](../lib/applications/index.ts) implement durable application state, supported employer forms, missing-answer continuation and confirmation requirements. Preserve this implementation while considering document-quality improvements separately.

Before implementing reuse, define its checks: source adapters need bounded live access/terms review plus schema, pagination, provenance, deduplication, country/city and partial-snapshot tests; matching additions need confirmed-versus-unknown profile cases and cross-profession regressions; sanitization needs legitimate multilingual and adversarial fixtures; export changes need rendered layout and extracted-text checks. This assessment itself changes documentation only, so verification is source-link/path review and `git diff --check`, not a claim that application or upstream runtime tests passed.

Verified by static source inspection: repository architecture, observed default-branch commit, MIT text, the six portal directories, selected HTTP/parser/helper code, CI configuration and dedicated test-file presence. Upstream [CI](https://github.com/ai-job-search-dev/ai-job-search/blob/83c788d779b74522bb346145ef675b984bf2d3f7/.github/workflows/ci.yml) defines Python tests, CLI typechecks/mock tests, skill/security guards and LaTeX smoke checks; it explicitly excludes live portal tests.

Not verified: upstream test execution or current CI results, portal/API liveness, listing accuracy, hosted-service terms for our intended use, complete third-party licensing, conversion lift, actual ATS compatibility, or compatibility with this application's data model. No reuse is implemented by this assessment.

