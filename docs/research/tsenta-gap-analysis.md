# Tsenta parity gap analysis

Assessment date: 1 November 2026. Target: the job-search product in this repository.

## Decision

We have the foundation of the find → prepare → apply workflow. We do not yet have evidence of Tsenta-level product parity. The largest gaps are dependable fresh supply, successful applications across complex employer systems, substantive document tailoring, and tracking what happens after submission. Additional channels sit on top of those capabilities.

Treat “exactly like Tsenta” as a capability and workflow target. There is no evidence available here of its private architecture, proprietary ranking, actual submission success rate, or operating cost. A visual clone would not close these gaps.

## Evidence and limits

- Tsenta evidence is first-party public documentation, inspected for this assessment. These are vendor claims, not independently measured outcomes. Detailed sources and contradictions are in [the product research](tsenta-product-research.md).
- Our evidence is the current local source, migrations, existing tests and operational documentation. Code presence does not prove a migration is applied, a service is configured, or a feature works in the deployed product.
- The working tree already contained application-task/recovery changes and continued changing during inspection. Those changes were left intact. This assessment includes their visible implementation, with validation limits below.
- No Tsenta account was created or authenticated dashboard tested. No real employer received an application. No live catalogue counts were queried. Historical staging counts are not presented as current inventory.
- This is a feature and operational comparison, not a pixel, usability or accessibility audit.

## Tsenta's product contract

The public product centers on discovering relevant jobs, preparing documents, submitting through employer forms, and following replies. It claims a monitored network of over 50,000 career pages and support for more than 30 employer systems. Those scale and coverage claims are not independently verified. [Product](https://tsenta.com/), [AI disclosure](https://tsenta.com/ai-disclosure).

The pricing page advertises 25 lifetime free submissions, then $19/600, $39/1,500 or $99/4,500 submissions per 30-day cycle in USD. Failed applications and unapproved drafts do not consume the advertised application allowance; Power adds unattended Auto Apply. [Pricing](https://tsenta.com/pricing).

## Feature matrix

Status describes our implementation: **present** means code exists, **partial** means a material part of the customer outcome is missing or unverified, and **missing** means no corresponding current customer flow was found. None means production acceptance is complete. P0 establishes the core outcome; P1 closes the web workflow; P2 expands access channels.

| Capability | Tsenta target / evidence | Our current state and evidence | Gap and priority |
|---|---|---|---|
| Resume-first onboarding | Upload once, confirm candidate background and preferences. [Getting started](https://help.tsenta.com/getting-started) | **Present:** resume import, extraction/review, profile and destination selection. `components/onboarding/onboarding-form.tsx`, `lib/server/resume/profile.ts`. | Verify completion, extraction corrections and recovery against deployed services. P1. |
| Fresh direct-employer discovery | Continuously monitored career pages; relevant new jobs appear in a match feed. [Product](https://tsenta.com/) | **Partial:** direct Ashby, Greenhouse and Lever feeds plus Arbeitnow; expandable database source directory, durable collection and retention. `lib/server/catalog/feeds.ts`, `lib/server/catalog/discovery/`. | Measure enabled, recently successful and candidate-relevant sources separately. Broaden providers and schedule refresh by demand/freshness. P0. |
| Search availability | Discovery continues without requiring the user to run every collection manually. [How fast](https://help.tsenta.com/how-fast-tsenta-applies) | **Partial:** shared catalogue plus bounded live requests. Three account requests/day, 12 shared new runs/day, one-hour reuse/cooldown; up to 96 boards/run. `lib/server/catalog/search-plan.ts`, migration `202610300016`. | The reported next-day lockout is expected under this policy. Decouple viewing fresh matches from starting a shared crawl; show quota scope, remaining allowance and precise reset. P0. |
| Matching and explanations | Resume/preference matching with job-specific context. [Product](https://tsenta.com/) | **Present/partial:** explainable rule scorer, hard preferences, cached scores and missing-evidence warnings. `lib/matching/index.ts`, `lib/server/matching/build.ts`. | Evaluate actual relevance against labelled candidate/job examples. Do not equate our numeric score with their score or interview likelihood. P0. |
| Search preferences | Role, location, compensation and experience preferences. [Product](https://tsenta.com/) | **Partial:** roles, skills, country/city, work mode, experience and excluded companies. Salary in application profile answers employer questions, but current `Job` and match scorer do not offer structured salary matching. `lib/candidate/index.ts`, `lib/jobs/index.ts`. | Add normalized listing compensation and salary filtering with explicit unknown handling. Assess employment type, graduation and other structured requirements. P1. |
| Paste a job URL | Bring a role found outside the feed into the application workflow. [Product FAQ](https://tsenta.com/#faq) | **Missing:** creation API requires a catalogue `jobId`; a public HTTPS target is accepted only after a catalogue lookup. `app/api/applications/route.ts`. | Authenticated URL import, job extraction, eligibility preview and duplicate reconciliation. Reuse existing destination guards. P0. |
| Per-role resume rewriting | Job-specific wording, reviewable changes and editing. [Resume help](https://help.tsenta.com/resume-tailoring-and-cover-letters) | **Partial:** AI selects up to six original paragraphs; assembly adds highlights followed by the full source resume. It explicitly cannot rewrite. `lib/server/tailoring/index.ts`, `lib/resume/index.ts`. | Build grounded section/bullet rewriting with source references and explicit approval of new factual claims; avoid duplicating the whole resume. P0. |
| Resume review and editing | Diff, approve/edit and saved editing preferences. [Resume help](https://help.tsenta.com/resume-tailoring-and-cover-letters) | **Partial:** plain-text editor, PDF preview, revisions and approval invalidation. No source-versus-tailored diff or conversational editor found. `components/resume/resume-editor.tsx`, `components/applications/application-review.tsx`. | Add change-level diff and separate document/form approval policies. Chat editing can follow core review. P1. |
| Cover letters | Per-role cover letter when supported or required by the form. [Pricing](https://tsenta.com/pricing) | **Missing:** packet has one resume, and form upload kinds do not model a separate cover-letter document. `lib/applications/index.ts`. | Cover-letter generation, review, versioned storage and correct field upload; missing required attachments must pause. P0. |
| Multiple base resumes | Named resumes/defaults/templates and selection for different searches. [Resume help](https://help.tsenta.com/resume-tailoring-and-cover-letters) | **Partial:** many per-job drafts, one canonical `resumeText` on the candidate profile. These are not a library of selectable base resumes. `lib/candidate/index.ts`, `components/resume/resume-drafts.tsx`. | Versioned base-resume library with explicit default/search selection. P1. |
| ATS document quality | Parseable, well-structured tailored documents. [AI disclosure](https://tsenta.com/ai-disclosure) | **Partial:** real PDF/DOCX export and upload; basic heading/bullet layout. Standard-font PDF generation drops unsupported characters. `lib/server/resume/pdf.ts`. | Add Unicode fonts, layout checks and extraction round trips. A displayed ATS score needs a defined rubric, not a success promise. P1. |
| Open-ended form answers | Role-specific answers drawn from candidate background. [AI disclosure](https://tsenta.com/ai-disclosure) | **Partial:** confirmed profile facts, saved-answer reuse and opt-in assembly of source passages/interests. No free-form personalized prose generation. `lib/server/applications/answer-resolver.ts`, `lib/applications/answers.ts`. | Add editable, sourced answer drafting while preserving abstention for unknown facts. P1. |
| Cloud form execution | Background multi-step form filling, upload and final submit. [Application records](https://help.tsenta.com/application-records) | **Present/partial:** durable workflows, Browserbase/Stagehand, screenshot-aware agent, generic controls, backend submission gate and receipt check. `workflows/applications.ts`, `lib/server/applications/computer-agent.ts`. | Validate representative complex employer journeys; accepting any HTTPS URL does not establish successful coverage. P0. |
| Broad ATS coverage | Publicly lists many systems, including Workday; eligibility still varies by role. [Supported systems](https://help.tsenta.com/supported-job-sites-and-ats) | **Unverified:** generic attempt capability and an Ashby optimization; historical synthetic acceptance is not a real-employer coverage matrix. | Publish measured support by provider, journey and failure class. Workday/account-based flows require access handling first. P0. |
| Employer sign-in/account creation/OTP | Employer account and verification handling. [Getting started](https://help.tsenta.com/getting-started), [email help](https://help.tsenta.com/connect-email-recruiter-replies) | **Missing:** computer agent explicitly forbids account creation/sign-in and pauses on verification. Fresh browser sessions have no persisted account context. | Secure employer identity/credential handling and consent, scoped OTP retrieval, resumable challenges and human handoff. P0. |
| Watch/replay application execution | Public disclosure advertises live overlay and replay. [AI disclosure](https://tsenta.com/ai-disclosure) | **Missing:** progress/task UI exists, but sessions deliberately disable recording and logs; no customer live browser/replay flow found. `lib/server/applications/browser-session.ts`. | Scoped live session access and resumable user intervention. Replay is a separate storage/retention decision; process steps are not a recording. P1. |
| Review versus unattended send | Controls for resume review and form review, alongside unattended operation. [Resume help](https://help.tsenta.com/resume-tailoring-and-cover-letters) | **Partial:** review/approve routes and automatic send authorization exist. Default Tailor & apply may authorize sending immediately; no equivalent independent document-review preference found. `components/applications/prepare-application-button.tsx`, application RPCs. | Make modes explicit and independently enforce document/form approval versions. P1. |
| Auto Apply | Saved searches, scheduling, thresholds, caps and pause rules. [Auto Apply](https://help.tsenta.com/turn-on-auto-apply) | **Partial:** opt-in threshold, candidate daily cap, five new starts per sweep, daily cron and page-triggered runs. No per-user timezone schedule, multiple saved searches or interview-based pause found. `lib/applications/auto-apply.ts`, `workflows/auto-apply.ts`, `vercel.json`. | Add search-specific policies and reliable scheduled admission; reuse current claims and deduplication. P1. |
| Application receipts | Inspect what was sent and the employer confirmation. [Application records](https://help.tsenta.com/application-records) | **Present/partial:** packet, approved revision, answers, resume and receipt text/URL/time/hash; uncertain sends cannot auto-retry. `lib/applications/index.ts`, `components/applications/application-review.tsx`. | Extend to every document and a readable immutable submission record; preserve uncertain-send protection. P0. |
| Post-submission pipeline | Application outcomes beyond sending, plus manual management/import. [Tracker](https://help.tsenta.com/track-job-applications) | **Partial:** execution states and self-reported applied/dismissed history. Current run groups omit interview/offer/rejection outcomes. Historical private pipeline tables do not make those a public feature. `lib/applications/activity.ts`, `lib/jobs/index.ts`. | Separate execution status from recruiting outcome; add timeline, notes and manual correction/import. P1. |
| Recruiter inbox and reply routing | Job-related mail associated with applications; public pages advertise automatic outcomes and recruiter drafts. [Privacy](https://tsenta.com/privacy) | **Missing:** no mailbox OAuth, ingestion, reply router or recruiter draft workflow found in current routes. | Add opt-in mailbox/forwarding integration, message-to-application matching, uncertainty handling and draft review. Tsenta's help/privacy descriptions conflict; do not assume their exact behavior is proven. P1. |
| Notifications | Web plus other channels. [AI disclosure](https://tsenta.com/ai-disclosure) | **Partial:** in-app unanswered-question alerts with polling; no product push, job email or messaging delivery found. `components/applications/application-question-alerts.tsx`. | Notify on fresh matches, blockers and replies with per-channel preferences and deduplication. P1. |
| Chrome extension | Handoff supported external job pages to cloud execution. [Extension help](https://help.tsenta.com/chrome-extension) | **Missing:** no extension manifest/customer bridge found. | Build after URL import and authenticated public API; avoid a second application engine. P2. |
| iOS/Android | Native review/apply/tracking channels. [Mobile](https://tsenta.com/mobile) | **Missing:** responsive web shell only. `components/shell/app-shell.tsx`. | Native apps and push using the same owned application APIs. P2. |
| iMessage/WhatsApp | Conversational onboarding, match approval and status. [Messaging](https://tsenta.com/messaging) | **Missing:** no messaging adapter/webhook/customer linking flow found. | Identity linking, channel consent and unambiguous approval tied to exact application versions. P2. |
| MCP/CLI | Profile, jobs, applications and account tools for external assistants. [MCP help](https://help.tsenta.com/connect-claude-chatgpt-mcp) | **Missing:** operator scripts exist, but no customer MCP server, OAuth scopes or installable CLI found. | Scoped customer API/MCP with audited actions and existing authorization checks. P2. |
| Networking | Contact search/verified-email allowances and outreach drafting. [Pricing](https://tsenta.com/pricing), [MCP help](https://help.tsenta.com/connect-claude-chatgpt-mcp) | **Missing:** no customer contact/enrichment/networking workflow found. Available developer connectors are not app features. | Separate contacts and reviewed outreach drafts; do not conflate application approval with outreach authorization. P2. |
| Billing and usage | Paid cycles, cancellation and success-based application accounting. [Billing help](https://help.tsenta.com/billing-refunds-and-cancelling) | **Partial:** plan/account tables and usage checks exist; seeded free allowance is 10 application admissions and 30 AI requests over rolling 30 days. No checkout/portal/webhooks found. Migration `202610300018`, `tests/plan-limits.test.ts`. | Hosted checkout/portal, entitlement lifecycle and reservation → confirmed-use/release ledger. Failed/prepared runs currently count toward application usage. P1; mandatory before charging. |
| Account lifecycle and trust | Public privacy/deletion policies and connected-service controls. [Privacy](https://tsenta.com/privacy) | **Partial:** owner-isolated data and session guards; deletion/privacy/retention remain documented launch gates rather than complete customer flows. `docs/production-release.md`. | User-facing export/deletion, integration revocation and retention across DB, documents and browser providers. P1; mandatory before public launch. |

## Why raising the refresh limit alone is insufficient

The observed refresh restriction is our own admission policy, not evidence that an external search API exhausted its quota. Both account-day and shared-day limits return the same generic message. The database resets them at midnight UTC, which explains a 05:30 IST reset. `lib/jobs/search.ts`, migration `202610300016`, and `components/jobs/fresh-job-search.tsx` show this path.

Changing 3 to a larger number would still leave shared capacity, limited source selection, stale boards and storage guards. The collector has a configurable default database budget of 400 MiB. Background collection is configured every six hours in a gated GitHub workflow, with a daily Vercel fallback; neither configuration alone proves runs are healthy. `lib/server/catalog/sync.ts`, `.github/workflows/catalog.yml`, `vercel.json`.

For parity, refresh should expose the latest shared feed immediately, report its assessment/collection times, and enqueue bounded refresh work only when necessary. Users should see whether they are waiting on their account allowance, shared capacity, storage or provider backoff. Keep these controls until real throughput/cost measurements justify changing them.

## Delivery order and acceptance evidence

### 1. Establish dependable discovery and application outcomes

Reuse the existing catalogue, match cache, workflows and account isolation. Add URL import; fix freshness/coverage visibility and quota explanations; complete preparation/recovery validation. Establish a measured coverage matrix before promising particular ATS support.

Acceptance: a confirmed profile receives relevant current jobs; an imported supported URL enters one owned workflow; missing data pauses with an actionable reason; a controlled receiver confirms exactly one send; uncertain sends never duplicate. Measure source age, time-to-new-match, completion/pause/unknown rates, and per-application provider cost. Employer submissions require separately authorized acceptance tests; synthetic tests cannot establish real ATS success.

### 2. Complete application materials and review

Add versioned base resumes, grounded rewrites, diff review, cover letters and richer answer drafts. Preserve the current source references and explicit unknowns. Exact parity does not require generating unsupported experience or metrics.

Acceptance: every factual change traces to confirmed input; fabricated metrics fail validation; editing either document or answer invalidates approval; uploaded PDFs match the approved version; PDF/DOCX text round trips preserve Unicode; required attachments reach the correct controls.

### 3. Handle employer access and interruptions

Add account/OTP capabilities and a secure same-session handoff where appropriate. Tie session expiry and continuation to the durable packet instead of asking users to restart blindly.

Acceptance: account creation/login and verification can complete or hand off cleanly, authorization cannot cross users, expired sessions recover before sending, and a lost receipt never triggers an automatic second submission. Test provider-specific account journeys separately from anonymous forms.

### 4. Close the tracking loop

Add recruiting outcomes and a timeline, then optional email connection/forwarding, reply routing and reviewed drafts. Add notifications and scheduled multi-search Auto Apply policies on top of reliable discovery.

Acceptance: replaying the same message/event does not duplicate it; ambiguous associations ask for review; interview/rejection transitions retain source evidence; manual corrections survive sync; interview pause actually prevents new admission; disconnecting revokes future mailbox access. Recruiter drafts remain user-reviewed.

### 5. Establish paid-product capacity and accounting

The current free-plan limits and scarce shared refresh runs do not support the advertised Tsenta volumes. A browser application can consume multiple model decisions, so 30 AI calls is not 30 completed applications. Increasing an applications column alone cannot close this gap.

Measure successful-send cost including browser time, model/image tokens, repeated preparation, storage, ingestion, email and support. Then define tiers, add billing and success-based usage settlement, capacity scheduling and alerts. Do not copy competitor prices before measuring our costs.

Acceptance: duplicate/out-of-order webhooks are idempotent; failure/skip does not consume a completed-send allowance; a confirmed send settles once; plan downgrade/cancellation applies correctly; concurrency cannot overspend entitlements; load testing establishes supported demand. No numeric delivery estimate or profitable price is claimed without this evidence.

### 6. Add access channels

Build Chrome, mobile, messaging and MCP/CLI as clients of the same authenticated application service. Networking is a separate capability with its own data and consent rules. Each channel must show the same documents, answers, statuses and usage.

Acceptance: equivalent authorized actions on every channel create/reuse the same run; switching devices preserves progress; revoking a channel blocks future access; conversational approvals identify an exact version and destination.

## Verification performed for this assessment

The final targeted command ran the following existing tests:

```sh
node --import tsx --test \
  tests/plan-limits.test.ts \
  tests/auto-apply.test.ts \
  tests/auto-apply-bounded.test.ts \
  tests/auto-apply-recovery.test.ts \
  tests/job-search.test.ts \
  tests/application-preparation.test.ts \
  tests/application-profile.test.ts \
  tests/application-questions.test.ts \
  tests/application-pipeline.test.ts
```

Result: **42 passed, 0 failed**, approximately 20 seconds. Earlier runs encountered preparation/recovery failures while those files were being changed elsewhere in the shared working tree; the final run above supersedes those results. No application code was changed as part of this research task. Document whitespace verification (`git diff --check`) also passed.

Verified conclusions include database-enforced daily live-search admission, the seeded rolling application/AI limits, auto-apply eligibility/selection, profile answer precedence, saved-answer ownership, and preparation task fencing/checkpoints. The entire application, current build, deployed configuration, actual Tsenta dashboard, and real ATS journeys were not verified by these runs.

Useful implementation entry points: [matching](../../lib/matching/index.ts), [catalogue feeds](../../lib/server/catalog/feeds.ts), [tailoring](../../lib/server/tailoring/index.ts), [application API](../../app/api/applications/route.ts), [application agent](../../lib/server/applications/computer-agent.ts), [auto-apply](../../lib/server/applications/auto-apply.ts), [plan limits](../../supabase/migrations/202610300018_monthly_plan_limits.sql), [task recovery](../application-pipeline.md).

## Recommendation

Use this matrix as the parity backlog. Start with the fresh-match → correct materials → confirmed submission → tracked reply loop. Keep the existing durability and evidence controls. Add channels after that loop is dependable. Do not assign a parity percentage, promise broad ATS coverage, or adopt competitor volume/pricing claims until the acceptance evidence exists.
