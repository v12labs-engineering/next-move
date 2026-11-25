# Application failure retry queue

Recoverable failures before send intent now reuse the existing durable application
queue. CAPTCHA failures, temporary network/provider failures, rate limits, invalid
model responses and per-attempt execution limits receive two retries, after 5 and
15 minutes. Each retry opens a fresh browser; no browser or AI call remains active
during backoff. Other applications can proceed while a retry waits.

Postgres preserves the approved packet, original approval/queue timestamps and
completed preparation outputs, increments the revision to fence delayed writes,
and limits retry scheduling to two retries. It does not refresh employer-conflict
acknowledgements. Claim-time job, approval and employer-conflict checks still run.
OTP/sign-in remains in the current browser with Telegram assistance. Exhausted
and permanent failures use the existing attention notification.

Any send intent, submit/confirm task, receipt, cancellation, stale revision or
changed approved packet blocks retry scheduling. A result recorded as
`submission_unknown` never becomes a new application attempt. Historical failures
were not automatically requeued.

The additive migration `202611050051_application_failure_retries.sql` was applied
to the verified application database `zcaqbiejkvgqxsbrncty` at
2026-11-05T03:08:31.521Z. Its SHA-256 is
`3ade55544f1734e0c1bff3fea1f63868ba9e00a3d22577d0f5ce37f0b1044bdc`.
The dry run excluded four unrelated unapplied migrations; only this migration was
applied and its hosted migration history was verified.

Verification:

- 681 tests passed, including worker tests for pre-submit CAPTCHA/network retries,
  OTP handoff, retry exhaustion and post-submit failure protection.
- The final SQL task-history adjustment passed all six queue/database tests.
- Hosted Postgres passed 11 generated-data acceptance checks inside a transaction
  that was rolled back: due times, duplicate/stale claims, queue release,
  submission-boundary protection and service-only scheduling.
- TypeScript, targeted ESLint, production build and function-bundle checks passed.
- No employer application was sent by these tests. Hosted DB acceptance does not
  establish real CAPTCHA success or independently test Workflow timer delivery.

Production deployment `dpl_4JhmynNvoZ25sCy79fzbdFzQDXu4` is READY and serves
`https://job-search-chi-amber.vercel.app` in the original `icn1` region. The source
hashes of all eight changed runtime/UI files, the retained CAPTCHA implementation,
and region configuration match the workspace. The deployment contains no private
environment files or diagnostic endpoints. The site returns HTTP 200; the recovery
endpoint returns 401 without the scheduler secret.

The task panel was also rendered with a queued form-fill retry: both “Retry
scheduled” and the scheduled timestamp are present. TypeScript and targeted lint
passed after this display correction, and the final deployed build passed.

The migration and worker release enable future handled failures to retry; no
historical failed or uncertain application was manually queued during release.
Workflow's actual 5/15-minute timer delivery was not independently exercised in
this acceptance run. Private verification artifacts are in
`.local-data/retry-queue/`. Local changes remain uncommitted.
