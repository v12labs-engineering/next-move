# Reusable application profile

Onboarding has a dedicated **Answers** step before the final **Auto-apply** step.
Contacts and unambiguous name parts are suggested from the resume. Availability,
relocation, travel, destination-specific work authorization and sponsorship,
salary expectations (including an approved single amount), and career interests
are visible during onboarding. Salary sections start expanded. Unknown answers
remain optional; required employer questions without grounded answers still wait
for the candidate. Invalid answer formats must be corrected before continuing.
Saving confirms reusable details, with the confirmation time stamped by the server.

New onboarding starts with auto-apply enabled and an 80-point minimum match score.
The final step explains unattended submission,
exposes the off switch and score control, and labels the action **Confirm and start
auto-apply** when enabled. Going back or replacing a resume preserves the chosen
setting. Existing profiles, including legacy profiles with no setting, retain
their auto-apply opt-in and minimum match score.

Preferences exposes the same answers at `/preferences#application-profile-section`.
Search roles, employment, education and projects continue to use the existing
reviewed resume rather than a second employment questionnaire.

Local verification: `node --import tsx scripts/verify/verify-onboarding.mts` uses a real
headless browser with mocked APIs to check defaults, opting out, answer visibility,
validation, navigation, the saved profile payload and existing-account settings.
Set `CHROME_PATH` when Chrome is installed outside the default macOS location.

The private `account_profiles.data.applicationProfile` stores contacts,
destination-specific current work authorization and sponsorship now/later,
calendar-day notice, earliest start date, relocation/travel choices, salary
ranges with currency/period/base-or-total basis, an optional approved single
salary amount, career interests, and permission to compose written answers.
Confirmation timestamps are stamped by the server. Confirmed answers do not
expire. Editing the form
requires renewed confirmation. Blank/unknown values never mean No or zero.
Application details also accepts a preferred full name and legal first/given and
last/family names. These are separately confirmed facts: a preferred-name field
does not imply a legal name. Ordinary full-name fields use the reviewed profile
name. Ordinary first/last fields use confirmed components, with the existing
two-word fallback when components are absent; names with more than two words
wait for confirmed components instead of guessing the split. Legal-name questions
always require confirmed legal components. Pronouns and name pronunciation remain
unanswered unless the candidate supplies an answer for that question.
Salary currency choices use a shared ISO currency snapshot so server and browser
locale-library versions cannot change the option list during hydration.

## Answering

After saved answers and confirmed profile facts are applied, every remaining
field (on the first page and on later/conditional pages) goes to one AI fill
pass with the resume, profile, answers already on the form and the job
description. It fills legal/first/last name and country/location from the
resume, picks exact options for choice fields, declines voluntary EEO questions,
accepts required privacy acknowledgements, and writes open-ended answers in a
plain first-person voice from resume facts (no em dashes or stock AI phrasing).
Work authorization, sponsorship, salary and notice are only answered from the
profile or resume; anything the evidence cannot support stays for review.
The rules below describe the deterministic layer that runs first.

Confirmed contact location also supplies residence fields before the AI pass.
A location such as `Hyderabad, India` fills Country with `India` (or the exact
observed ISO-code option), and fills current-location controls with the saved
location. Searchable controls can start with that value before options load.
Unknown countries, ambiguous options, citizenship, birthplace and desired
destinations remain unresolved; the job's destination is never substituted for
the candidate's residence. Explicit answers and ask-again choices still win.

Preparation freezes the application profile, destination and up to 12,000
characters of job description in the private packet's `applicationContext`.
Later-page and conditional questions use that snapshot in both form engines.
Changes to Preferences do not rewrite an approved packet while it is sending.

Explicit answers, including deliberately blank answers, win. An employer-specific
**Ask again next time** preference also blocks profile and generated fills.
Explicitly reusable
saved answers are checked before profile answers. Common question variants map
to typed facts. Negations, combined claims, conflicting countries, unsupported
controls, declarations, consent, and personal demographics remain unanswered.
Relocation/travel booleans do not imply a particular city or travel percentage.
Skill presence or estimated total tenure never establishes years with a skill.

Text salary answers include the complete range and units. Numeric salary fields
require an explicit matching currency, period and compensation basis, plus an
approved single amount (or equal range endpoints). There is no currency or pay
period conversion. Start dates use the later of today's date plus notice and
the saved earliest date. Availability answers use calendar days only.

Written-answer composition is separately opt-in. The configured AI SDK provider
selects existing resume block IDs and, for interest questions, a job-description
block and the candidate's own career interests. The server resolves IDs and
assembles whole blocks; the model cannot supply new prose or alter source
wording. Unknown references, quantitative factual questions, missing interests,
provider failures and exhausted quotas leave questions unresolved. This is
grounded source assembly, not unconstrained rewriting. Each extra provider
attempt uses the existing per-account AI allowance and per-run decision budget.

`answerEvidence` stores the actual answer, source and confirmation date. The
application review shows provenance only while the answer still matches it.
Existing `answerSources` and saved-question behavior remain compatible.

## Updating waiting applications

**Save and continue waiting applications** first saves the profile using the
existing optimistic version check, then calls the authenticated
`POST /api/applications/fill-profile` action. Up to 50 ready packets are checked
in oldest-first order. Known profile/identity and approved saved answers fill
absent values without an AI call. Changed answers or application context are persisted even when a current question remains unanswered, so later pages receive the confirmed facts. Updated packets receive a new revision and
lose their old approval. Ownership, idle state and revision are checked on every
service-side write. Only previously automatic applications with complete answers
are approved and dispatched by this explicit action. Manual applications remain
ready for review, and unknown declarations still need answers. The response
reports updated, queued and skipped counts; queueing is not a submission receipt.
Existing alerts disappear as their required questions are answered. Larger
backlogs can be processed by repeating the action.

## Application admission and rollout

Apply `202611010032_application_profile_reuse_overrides.sql` before releasing
profile answering; it returns explicit per-employer opt-outs through the existing
service-only question-memory reader. No new account grants are added.
Apply `202611190097_remove_application_daily_limit.sql` before deploying the
updated Preferences. The shared admission function ignores saved
`autoApply.dailyLimit` values for manual and background requests and enforces
rolling 30-day application and AI allowances. The account row lock serializes
admissions. Existing applications are returned before quota checks.

Profile data and packet evidence need no new tables; they inherit existing RLS,
ownership and packet approval rules. Local verification does not apply migrations
or deploy the app.

## Verification

`tests/application-profile.test.ts` covers schema compatibility, confirmation,
country/polarity guards, salary units, availability, precedence, source assembly,
and conditional forms. Existing account RLS tests exercise private application
details. Plan-limit tests exercise the migration, manual and background
admission beyond a previously saved cap, and idempotency.

For a local app explicitly configured with isolated staging credentials:

```sh
node scripts/verify/verify-application-profile.mjs --origin=http://localhost:3018
```

This creates and removes generated accounts and an inactive synthetic listing.
AI resume extraction is stubbed in the browser; profile/application APIs and
database persistence are real. It checks onboarding, reload, mobile overflow,
stale saves, batch fills, provenance, unresolved declarations, alerts, manual
submission protection and cross-account isolation. No email or employer
application is sent. Screenshots are saved only in ignored `.local-data/`.

## Live onboarding and automatic submission verification

Unanswered employee-referral and professional-reference questions are excluded
from AI generation. An explicit candidate answer (including “No employee
referral”) or an approved reusable answer remains usable; absence of evidence
must not become “None”.

The synthetic receiver validates omitted native-runner fields against the frozen
approved application profile. Explicit packet answers, including blank answers,
take precedence. It never reads the current account profile to approve a send.
Missing ordinary identity may use the completed preparation identity checkpoint;
legal names, preferred names, LinkedIn and destination authorization require
confirmed approved facts. Consent and referral still require explicit answers.

`node scripts/verify/verify-onboarding-live.mjs --deployment=dpl_...` checks the supplied
live deployment with generated data only. It exercises actual resume analysis,
onboarding save and reload, ten reusable answer types through the live resolver,
and the automatic browser against the synthetic employer. It requires a pause
for the unknown referral and exactly one confirmed receiver submission. Generated
accounts and listings are removed afterward. The receiver covers name parts,
email, LinkedIn, authorization, referral, consent and the approved resume; salary,
notice, start date, relocation, travel and sponsorship are checked through the
live resolver. Scheduled matching is not exercised by this targeted test.

Regression coverage: `tests/application-answer-resolver.test.ts` and
`tests/application-test-receiver.test.ts`.

Verified live on 2026-11-10 with deployment
`dpl_Ac6RmL9wJgmpNhbWeyepdv85ojoa`: application
`13c2ab74-f943-47da-ab41-9536159ac1a5` paused for its unknown referral,
continued after the synthetic candidate supplied it, and reached `submitted`.
The receiver recorded exactly one submission at `2026-11-10T06:34:44.148Z`.
No real employer was contacted; generated account and listing cleanup passed.
Private local evidence is in `.local-data/live-onboarding-evidence.json` and
`.local-data/live-onboarding-report.json`. The focused 61 tests, TypeScript,
lint, and deployed production build passed.
