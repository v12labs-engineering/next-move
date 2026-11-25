# Automatic application tasks

Apply `202611010034_application_tasks.sql` after the earlier application migrations
and before deploying the task reader and workers. This is an additive migration;
existing applications begin without task history. No hosted migration or live
employer application is implied by local tests.

The existing Vercel Workflow orchestrates preparation, durable retry waits,
automatic approval and submission. Postgres owns per-application task checkpoints
and customer-visible progress. There is no second queue or new provider.

## Tailor & apply interaction contract

Migration `202611060059_continuous_application_retries.sql` keeps automatic
permission through preparation retries and an explicitly requested retry of an
unconfirmed submission. The explicit retry starts a new attempt at its revision;
subsequent answer edits retain that attempt. Send-history checks, temporary
failure recovery, Telegram answers and profile refill all respect this boundary.
Migration `202611080064_automatic_unconfirmed_retry.sql` adds one automatic retry
after a new unverifiable automatic send, with a persisted 15-second delay. The
database advances the revision and attempt boundary while retaining the frozen
packet, earlier events and tasks. The workflow waits before sending again;
dispatch recovery can pick up the queued revision after process death. The
allowance survives restarts, edits and explicit retries. Existing historical
outcomes, manual runs, saved receipts, changed packets and explicit employer
rejection never trigger this retry. If the extra attempt is also unverifiable,
the UI offers **Try again**, without asking the candidate to contact the employer.
Choosing **Try again** authorizes another attempt without a review checkbox.
No historical applications are changed or resent by the migration.

The regression matrix in `tests/application-continuous-flow.test.ts` covers
explicit retry, unknown questions, answer edits, Telegram selection, transport
backoff, app/Telegram/step preparation retries, ownership and replay protection.
The mobile review harness checks the automatic status card without a manual
approval gate. Final success still requires the employer receipt and queues the
existing Telegram submission notification.

The live Bluesight verification also reproduced an opening-stage failure in
CAPTCHA detection: a newly attached iframe had an empty URL, causing `new URL`
to throw before Browser Use started. The detector now skips unparseable or
non-HTTPS frame URLs, continues inspecting later challenge frames, and still
propagates actual attached-frame inspection failures. Regression coverage is in
`tests/application-captcha-detection.test.ts`.

The click authorizes preparation and sending for that job. A complete automatic
packet proceeds without review approval. The user is asked only for genuinely
unknown required information (in the app) or an employer OTP/code (Telegram).
Saving the last answer resumes automatically. Manual review-first applications
retain their existing controls.

The native runner and its Telegram bridge enforce code-only assistance for
automatic runs. They do not hand CAPTCHA, dropdowns or browser navigation to the
candidate. Failed automatic CAPTCHA recovery before intent uses the existing
bounded retry queue; failure after intent stays unconfirmed. Unsupported login,
provider limits, closed jobs and exhausted retries remain explicit unsuccessful
outcomes. This contract does not guarantee that every employer permits automation.

Known identity/profile facts are resolved before asking questions. Provider
errors while generating grounded answers remain worker errors, so a temporary
outage can retry rather than asking the candidate to write the answer. OTPs and
passwords cannot be persisted through the missing-answer tool. A connected
Telegram account is required when an employer asks for a supported code.

The existing `202611060056` migration remains required; these runner changes add
no migration. Local verification covers worker/agent/bridge behavior, actual SQL
continuation guards, generated mobile review UI, and intercepted Chrome challenge
and OTP flows. It does not establish deployment or real-employer success.

## Account application queue

Apply `202611030045_application_queue.sql` before deploying the queue-aware
workers and application list. **Tailor & apply** adds the job without leaving the
job list, so candidates can add several jobs. Rapid requests for the same saved
job reuse its existing application and admission quota reservation.

Migration `202611060058_application_concurrency.sql` raises the account limit to
two applications across preparation and submission. Postgres serializes claims
under the account-profile lock and admits the oldest eligible jobs into those
two slots. Preparation and its automatic send retain the same queue position.
An active verification-code wait retains its slot and browser. Separate accounts
run independently; the same-employer send and uncertain-receipt guards remain.
Workflow timers recheck waiting claims every 15 seconds without holding a browser
or making AI requests; existing preparation backoff timers still apply. This is
an account queue, not a global provider-concurrency limit.

With migration `202611120071_application_boat_batches.sql`, the Boat provider
reuses one VM per account while its browser queue is busy. Each attempt has a
separate Chrome process and an expiring lease, including during an OTP wait.
The idle timer stops the VM when browser work drains. Provider saturation still
follows the bounded retry path. See [Boat worker setup](../workers/browser-use/README.md#boat-configuration-and-deployment).

Applications shows **In queue**, **In flight**, **Needs you**, **Submitted** and
**Cancelled** separately. The queue filter uses oldest-first order and displays
job titles before a packet exists. Progress reads and stale-worker recovery never
expire a queued entry. Waiting time does not consume initial automatic permission
or frozen-approval freshness; packet edits and cancellation still invalidate
permission. The preparation window starts when the worker claims the job.

Missing answers, qualification gaps, failures requiring review and cancellations
release the next job. Continuing a reviewed packet joins the tail with explicit
approval. An unverifiable automatic send enters the queue once more under the
policy above; the existing same-employer guard still applies to other runs. Pending
dispatch recovery also visits review-approved queued sends and automatic packets
interrupted between preparation and queueing. It never replays an active or
uncertain revision directly. Hosted scheduler delivery still requires staging verification.

`tests/application-queue.test.ts` executes the migration against PGlite and checks
duplicate admission, reversed/duplicate worker claims, ordering across both
phases, independent accounts, ownership, cancellation, review, long waits and
uncertain-send guards. It also checks Workflow wait decisions and release of
packets missing required answers. PGlite serializes its queries; verify concurrent
transactions on hosted Postgres as part of staging acceptance.

| Task | Saved result / stopping point |
| --- | --- |
| Load profile and job | Snapshot of the source profile, contact email and hydrated job |
| Find and read application form | Observed form structure; no candidate data entered |
| Tailor resume and check qualifications | Grounded resume and qualification assessment |
| Prepare answers and validate application | Validated private application packet |
| Check permission to send | Approved revision, active job and employer cooldown checked |
| Fill employer form | Pauses on unanswered questions; candidate continues in the app |
| Send application | Persist send intent before the external submit action |
| Verify employer receipt | Persist the employer confirmation before reporting success |

The progress UI shows seven tasks. The internal `check_application` record is
folded into form filling: it checks the existing approval snapshot, duplicate
history and listing state automatically, without requesting another permission.
Its failures remain visible under form filling. Removing a progress step does
not bypass ownership or allow resending an uncertain application.

Native receipt verification reads visible top-level pages and embedded employer
frames, normalizes whitespace and typographic punctuation, and saves the actual
observed acknowledgement. If the browser worker exits after send intent, the
server polls for up to ten seconds in that same session before releasing it,
bounded by the remaining run deadline. Reported quotes receive up to three seconds
to appear. Unrelated footer/support error text does not invalidate an explicit
success acknowledgement; actual submission failures still reject it.
It does not reload or submit again. Generic thanks, pending verification, hidden
frames, and rejected submissions do not establish a receipt.

Preparation tasks save their results independently, keyed by application, packet
revision and stage. Replaying preparation uses completed results and retries only
unfinished work. Known temporary network errors, timeouts, HTTP 429 and server
errors have at most three attempts per task with waits of 30 then 60 seconds.
Postgres enforces both the attempt budget and the next retry time across duplicate
dispatches. Repeated tailoring reserves an additional shared AI decision attempt.
Discovery and answer-generation decisions continue to reserve their own attempts.
Configuration errors, processing limits, sign-in/OTP, unsupported forms and
unknown errors pause for attention rather than repeatedly using provider capacity.

Failed preparation rows also offer **Retry this step**. The authenticated
`retry_application_step` RPC requires the exact owned revision and a failed
preparation stage. It creates a fenced new revision and copies only completed,
nonempty upstream checkpoints; the selected step and all downstream work rerun.
A tailoring retry therefore reuses the loaded profile/job and discovered form.
Old task history and outputs remain unchanged and service-only. The retry clears
approval and automatic-send intent, so the resulting packet requires review.
The existing three-preparation-attempt ceiling and account AI quota still apply.
Active workers, completed steps, cancelled runs and sending/uncertain/submitted
applications cannot use this action. Apply `202611020042_application_step_retry.sql`
before releasing the per-step retry route and UI.

A manual preparation retry creates a fresh revision through the existing RPC,
retaining its quota and retry restrictions. It intentionally rereads source facts
and the employer form. Old checkpoints cannot authorize or populate that revision.
The HTTP action uses `retry_application_preparation_revision` to lock and check
the revision shown to the candidate before invoking those existing retry rules.
Apply `202611080062_revision_fenced_preparation_retry.sql` before deploying this
route. Delayed requests cannot restart a newer cancelled or failed revision;
current explicit retries and Telegram's existing revision checks are preserved.

Preparation claims carry a random worker token. Every task write and packet
publication checks that token, the current status and the revision. The scheduled
auto-apply sweep reclaims up to 100 automatic preparation workers whose last
progress is older than ten minutes, invalidating their tokens before redispatch.
Further sweeps drain larger backlogs. Exhausted preparation stays paused.
Cancelled records and active or uncertain submissions are never reclaimed.
Reads of automatic preparation progress preserve the sweep's recovery intent.
This requires the existing auto-apply sweep scheduler to be running.
The checked-in cron invokes that sweep daily, so process-death recovery can wait
until the next daily sweep. Handled temporary failures use Workflow timers and
do not wait for that cron. More frequent crash recovery needs a separately
verified scheduler configuration.

Submission uses a separate Workflow step with SDK retries disabled. Before send
intent, known temporary failures can enter the durable retry queue described below.
Each attempt opens a fresh browser and validates the frozen packet. It records
send intent before clicking;
an uncertain result queues the single extra automatic attempt when eligible,
otherwise it becomes `submission_unknown` and offers **Try again**.
Task logging never substitutes for the authoritative application receipt.
Progress reads allow running and submitting workers fifteen minutes before
declaring them stale, matching scheduled recovery and exceeding the 770-second
send budget plus cleanup. Opening the detail page must not invalidate a live
submission or prevent its receipt from being saved. Preparation retains its
separate ten-minute recovery policy.

The application detail endpoint returns task labels, state, attempts, safe error
codes/messages, retry times and timestamps. Checkpoint outputs are service-only;
authenticated accounts can read only their own task metadata and cannot write it.
Raw provider errors, signed browser URLs and credentials are never stored in the
customer-visible task messages. Tasks and outputs cascade when the application or
account is deleted. The progress view covers the current revision; older task
metadata remains available in the detail response (up to 100 recent tasks).

The application message and task panel use the same safe failure reason.
Unsupported form controls and employer cooldowns have separate reasons.
Processing timeouts are distinguished from account allowances.

An informational employer application-limit notice remains in the review packet;
its presence alone does not establish that the candidate has exceeded the limit.
Ashby explicitly distinguishes its pre-submit
[application form callout from a blocked-application message](https://docs.ashbyhq.com/application-limits).
The runner retains its known employer cooldown check and the normal portal's
enforcement. It does not change candidate identity or bypass a portal rejection.
Approval, required answers, one persisted send intent and a verified receipt are
still required. A send without a verified receipt remains `submission_unknown`
and cannot automatically resend. Local regressions cover saved and newly observed
limit notices, a confirmed send, an unconfirmed send and the known cooldown.

Verification: `tests/application-pipeline.test.ts` executes the actual migration in
PGlite and checks ownership, output privacy, worker fencing, retry budgets, backoff,
cancellation and exclusion of sends from recovery. The preparation regression
injects a temporary tailoring failure and verifies completed discovery/source
tasks are reused. Existing application tests exercise approval and receipt rules.
Local verification does not establish hosted scheduler delivery or browser success
on a real employer. Confirm those on an isolated staging application before release.

Run the deployed synthetic acceptance flow with
`node scripts/verify/verify-application-runner.mjs --synthetic-only --pipeline-retry`.
It generates its own account, temporarily removes only its own receiver to induce
a browser timeout, restores the receiver after a visible retry decision, and
asserts checkpoint reuse, answer/approval gates, account isolation and one receipt.
It captures the retry and submitted task panels in ignored `.local-data/` and
deletes generated accounts on exit. No real employer receives anything.

When browser minutes are exhausted, use `--synthetic-only --pipeline-blocked`
instead to verify the real provider-limit error in the deployed task panel,
one blocked attempt, no scheduled retry and zero submissions. This negative check
does not substitute for the successful retry/submission acceptance flow.


## Recoverable application failures

Apply `202611050051_application_failure_retries.sql` before deploying the retry-aware
workers. It is additive and does not enqueue historical failed or uncertain runs.

Failed automatic CAPTCHA solves before send intent, temporary browser/network or
HTTP failures (including 520/429), invalid model responses and per-attempt execution
limits can queue **two retries: after 5 minutes and 15 minutes**. The original
attempt plus these retries is a maximum of three browser attempts. CAPTCHA failures
during preparation use the same cooldowns with the existing three-attempt task cap.
Other preparation errors retain their existing 30/60-second backoff.

Postgres atomically schedules the retry and saves its due time. It retains the
unchanged approved packet, original queue/approval timestamps and completed
preparation outputs. It increments the revision to fence the old worker, carries
only existing employer-conflict acknowledgements without refreshing their expiry,
and reruns approval/job checks and form filling in a fresh browser. Other jobs can
run while a retry waits. The task panel shows `retry_wait`, its reason and due time.
Workflow sleep holds no browser or model call. The five-minute recovery endpoint
also redispatches pending intents if dispatch or a workflow result was lost; claims
reject early, duplicate, cancelled and stale-revision attempts.

OTP/sign-in still use Telegram in the current browser. Exhausted retries and
permanent failures require attention and use the existing Telegram notification.
Any persisted send intent or submit/confirm task in the current authorized attempt,
a verified receipt, or a `submitting`, `submitted` or `submission_unknown` state
makes retry scheduling ineligible. An ambiguous submission never starts another
attempt automatically. The API is
service-only; authenticated users cannot manufacture retry permission.

Verification covers actual Postgres migration behavior in PGlite plus the worker's
browser-release, pre-/post-submit, OTP, exhaustion and failure paths. Hosted
migration/scheduler verification is recorded separately from those local results.

### Retrying an unconfirmed submission

An owner can select **Try again** on a `submission_unknown` run. The
`retry_unconfirmed_application` RPC checks ownership and the exact revision,
rejects receipts and other statuses, and reopens the saved packet as `ready` in a
new revision. It clears the previous frozen packet and per-attempt counters,
sets automatic continuation, and moves `attempt_start_revision` to this revision.
Existing events and tasks remain on their old revisions. The explicit retry
authorizes sending the saved packet without another approval; missing required
answers still pause, and normal submission quotas and employer checks apply.
The UI presents the retry directly. This action is independent of
the preparation retry limit because it reuses the saved packet.

## Continuous auto-apply (2026-11-06)

Migration `202611060056_continuous_automatic_applications.sql` supersedes the
review stops above for automatic applications. `automatic` retains the user's
instruction across missing-answer pauses and answer edits. The per-revision
frozen packet is still invalidated and recreated before sending. Qualification
assessments are advisory; they never invent qualifications or block an otherwise
complete form. Required employer questions still need valid, grounded answers.

Saving the last answer in the app queues the exact new revision and dispatches
submission without another approval. The recovery sweep also visits ready
automatic applications whose old one-time timestamp was cleared, so a lost
dispatch or an old review stop does not strand a complete application. Missing
answers release the account queue without disabling automatic mode. Manual
applications, cancellation, employer conflicts and active work retain their
guards. A receipt or send intent within the current authorized attempt excludes
automatic requeueing. Migration `202611060059` introduces that attempt boundary
and preserves automatic dispatch through answer edits and preparation retries.
Transient failures retain bounded automatic retries; a closed employer form,
provider limit or unconfirmed send cannot be made successful by approving again.

Verification uses the actual SQL function for complete, missing, stale, manual,
cancelled and previously sent cases. The hosted synthetic runner asserts saving
the final answer queues submission without calling the approval endpoint again.

An interrupted Browser Use worker, truncated worker stream or missing backend
checkpoint now enters the existing bounded retry queue before send intent.
Worker task-size configuration failures remain nonretryable. The same worker
failure after send intent uses the single automatic retry when eligible, then
stays available for an explicit **Try again** action.

### Observed verification takes precedence over the requested tool

On 2026-11-06, Motional's run detected a visible challenge after send intent,
then terminated as `receipt_unconfirmed` because the model had called
`request_missing_answers`. The verification handler previously recognized only
codes; an identical challenge worked if the model chose `solve_captcha`.

The native runner now routes observed codes and challenges consistently from
all three verification/missing-answer tools. It tries the configured solver for
an observed challenge, checks that the challenge actually disappeared, and
retains the same session for supported code verification. An explicit unsolvable
grid result requests a fresh challenge once through its visible reload control,
preserving the form and resume attachment within the original solver budget.
Manual applications can still use human challenge assistance after send intent;
automatic runs use the single extra application attempt if solving still fails.
Pre-send failures retain bounded retry behavior.
Clearing verification is not a receipt: actual employer acknowledgement is still
required, and this path never starts or submits another application.

Run `node --import tsx scripts/verify/verify-native-challenge.mts` for a real Chrome replay
of the observed sequence against generated, fully intercepted pages. It checks
all three tool paths, solver success, manual human fallback and automatic failure
without a handoff. It checks one submit action and a receipt only on success.
This uses no real CAPTCHA, employer, Telegram recipient or model.
## Application follow-up

The detail page for an application with an employer-confirmed receipt loads
follow-up suggestions automatically. Each includes a name, current title,
LinkedIn profile and a short draft based on the recipient’s role and the job.
Select **Copy message** to paste the draft into LinkedIn.

For jobs you applied to yourself, open **Applications → Marked applied**. The
five most recently marked jobs without an employer-confirmed receipt load
suggestions automatically. Eligibility spans all countries. Apply migration
`202611110069_manual_application_followup.sql` to enable this entry point.

Connected Telegram chats receive the same contact suggestions and draft messages
through the five-minute notification sweep. New confirmed submissions and jobs
marked applied queue delivery. Opening an eligible older application can also
queue its suggestions. An empty lookup completes without a message. Apply
`202611110070_telegram_application_followup.sql` before deploying the sender.

The server uses [BlitzAPI People Search via Firecrawl Alexandria](https://alexandria.firecrawl.dev/blitzapi)
with the employer and role from the application. It returns up to three matching
profiles. Candidate information and the application packet stay in the app.
Apply migration `202611110068_application_followup.sql` and set
`FIRECRAWL_API_KEY` on the server. Successful lookups are reused for seven days.
New lookups are limited to 20 per UTC day, with a ten-minute cooldown after an
unsuccessful request for the same application.
