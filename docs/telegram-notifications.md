# Telegram application review

Configured on 2026-11-02 for [@V12NextmoveBot](https://t.me/V12NextmoveBot) and
`https://job-search-chi-amber.vercel.app/api/webhooks/telegram`. The existing
Supabase project is `zcaqbiejkvgqxsbrncty`; migrations `202611020038` and
`202611020041` are applied.
Production credentials are stored as server-only Vercel variables, with the bot
token and webhook secret marked sensitive. No credentials are stored in this guide.
The deployed callback was tested with an invalid secret (401) and the configured
secret (200); Telegram's webhook readback matched the public app URL.
Live verification recorded one real account connected, one delivered application
notification and zero recorded notification delivery failures; the user confirmed
it was working. The unused generated QA account was kept separate from the real
connection. Approval-to-submission and an employer receipt were not tested live.

The AI draft update was verified live on the pending FAR.AI application: three
labeled proposals were persisted and the revised prompt was delivered. Its
existing confirmed answer and application packet were preserved, and the request
remained pending user approval. Local validation passed 356 tests, lint,
typecheck and the production build; the hosted build and secret checks passed.

Telegram carries questions and approval actions; the existing AI SDK application
preparation, Supabase packets, revision checks and employer receipts remain
authoritative. The transport uses Telegram's official Bot API over HTTPS. It
requires no extra database, direct PostgreSQL URL, message template, or app-review
submission for an ordinary bot. Each user must first start and link the bot.

## Setup

Create a dedicated bot using `/newbot` in [BotFather](https://t.me/BotFather).
Choose a display name such as Next Move Applications and an available username
ending in `bot`. Keep the returned token private. The interactive credential
wizard prepared for this setup captures it with hidden input in ignored
`.env.telegram.local`, with owner-only permissions. Never paste it into chat.

Run `node --import tsx scripts/setup-telegram.mts` to validate the token using
`getMe`, discover the bot username, generate the webhook secret and use the app
origin from `staging/project.json`. It reuses `.env.staging.local` solely to check
the identity and schema of the existing Supabase project. The ignored credential
file leaves `TELEGRAM_ENABLED=false` until the hosted setup is ready.

Review and apply `202611020038_telegram_approvals.sql` to the existing isolated
Supabase project. Do not apply unrelated pending migrations as part of this setup.
It adds RLS-protected link/connection/review/replay tables, service-only transitions
and an application trigger that persists pending questions. All database access
uses the existing Supabase URL and service key; no Chat SDK state tables or direct
database credentials are needed.

After the migration, `node --import tsx scripts/setup-telegram.mts --sync-vercel`
writes only the five TELEGRAM variables to the existing project's production
environment. Bot token and webhook secret are sensitive values, passed on stdin
to the CLI. Deploy the reviewed Telegram release, then run
`node --import tsx scripts/setup-telegram.mts --register-webhook`.
It first probes the deployed endpoint with a secret-authenticated empty update,
then registers the canonical `/api/webhooks/telegram` URL and reads it back. A bot
with a different existing webhook is rejected instead of silently repurposed.
Only message and callback-query updates are requested; pending updates are kept.

## User flow

In Preferences, opt into Telegram application notifications, choose Connect
Telegram, open the bot link and tap Start. Return to Preferences and confirm the
displayed Telegram ID suffix. The short-lived, hashed connection token alone does
not link an account. One Telegram identity can belong to only one app account.
Group messages, bot senders and callbacks from a different sender are ignored.

The connector presents one selected application/question at a time. Send
`/applications` to browse waiting applications and recent confirmations, then
choose the job to continue in Telegram. Lists have ten jobs per page. Attention
alerts open the current question directly for an automatic application with a
reviewable packet. Complete packets open their review summary directly. There is
no preliminary **Continue here** message. Failures without a reviewable packet
show the failure reason and **Check status**. Opening a review preserves drafts and confirmed
answers while invalidating old prompt replies; an older unanswered review does
not block the selected job. Existing link-only messages are unchanged; use
`/applications` to continue those jobs.
Exact saved answers and grounded evidence from the existing preparation flow can be proposed with a
source. When neither is available, eligible opinion and motivation questions get
an AI-generated draft, explicitly labeled as unconfirmed. The existing configured
AI SDK provider generates it from the question and public job context; no resume
or contact details are sent for this step. Migration `202611020041` reserves at
most one attempt per review request against the existing account AI allowance.
Model failures or exhausted allowance leave manual entry available. Snapshot and
version checks discard drafts that race with user edits. Drafts remain in the
review state, outside application answers and the saved-answer library.
Unknown facts, consent and declarations are never invented. Use answer
confirms a displayed proposal. Edit opens a reply prompt; a reply to that exact
prompt is tied to the saved turn. The displayed code is a fallback if sending a
separate message. Edited text is shown again and needs Confirm answer.

Prompts show the employer field type, required status and help text. Selects,
comboboxes, radio buttons and Yes/No fields use single-choice inline buttons.
Checkboxes use independent toggles with checked/unchecked markers; a required
checkbox question cannot confirm an empty selection. Selecting an option creates
a draft and still requires **Confirm answer**. Suggestions remain labeled and
can be explicitly accepted with **Use answer**.

Long lists show eight options per page with Previous/More controls. Full option
values appear in the message even when button labels are shortened. Pagination
preserves selections; every choice and page button uses the same version checks
as approval buttons. Text, long text, email, phone, URL and numeric fields use
reply prompts with format guidance. Existing pending requests need no migration.
These are Telegram chat controls: actual HTML dropdowns or input widgets require
a [Telegram Mini App](https://core.telegram.org/bots/webapps).

Approve & send appears only after all missing answers are confirmed. The summary links to the prepared resume on the authenticated application page, and includes answers and employer notices
and the current application's warning, including unconfirmed qualifications.
The authenticated detailed view is optional. Final approval checks linked
identity, application revision, packet snapshot and request expiry, then calls
the existing atomic review/approval RPC without opting into answer reuse. Dispatch
intent commits in the same transaction and replays through the existing worker
claims. An approval means queued to continue, never employer receipt confirmed.
Unsupported fields and manual-only applications still require their supported
review surface; Telegram does not invent answers or bypass employer controls.
Status and confirmed receipt text can be checked in chat. An uncertain submission
never offers resending.

Every callback is version-bound and every incoming update ID is deduplicated in
the transition transaction. Old replies cannot answer a new question. Long text
is split without truncating the proposed answer or using HTML/Markdown parsing.
The webhook uses constant-time verification of Telegram's secret header and
acknowledges only after processing commits. It accepts at most 1 MB of JSON.
Tokens are never printed in raw transport errors, URLs or provider bodies.

Reply `/stop` or STOP to disconnect. Pause stops this Telegram request. Neither
action cancels an application or revokes an already committed submission request;
use the app's cancellation action for that. Requests expire after 24 hours. In-app
edits/cancellation invalidate pending buttons. Use `/applications` to revisit a paused or expired request while its exact
application revision remains reviewable.

## Recovery and verification

### Submission confirmations

Migration `202611060057_telegram_submission_notifications.sql` adds a separate
service-only delivery outbox. Saving a `submitted` application with its verified
employer receipt queues a confirmation in the same database transaction for a
connected Telegram account. The worker attempts delivery immediately; the
existing five-minute Telegram sweep recovers missed sends. The message includes
the company, role, employer confirmation and a **View confirmation** status button.
Queued, failed and uncertain applications never generate a success notification.

One row per application, delivery leases and saved Telegram message IDs suppress
ordinary worker/sweep replays. Failed delivery uses bounded backoff (five attempts)
and never changes or resubmits the application. As with other Telegram alerts,
a lost provider response can still duplicate a message. Disconnect removes pending
delivery; reconnecting does not replay past submissions. The migration does not
backfill historical receipts. Tests in `tests/telegram-submission.test.ts` cover
transaction rollback, receipt gating, replay, recovery, recipient changes and RLS.

Apply `202611030043_telegram_attention_notifications.sql` before deploying the
attention-alert sender. It adds a service-only outbox and backfills current
`needs_attention` applications for connected accounts. SQL queues alerts; it does
not send messages or change application packets, approvals or status.

Deploy the sender before applying `202611080063_telegram_waiting_question_alerts.sql`.
It extends the same outbox to `ready` applications with missing or invalid required
answers, including currently waiting applications. An older selected, delivered,
or exhausted review cannot suppress these alerts. Each alert has an **Answer
questions** button that selects that exact application/revision when clicked;
sending the alert does not switch conversations, fill answers, or approve a send.
Manual applications link to their authenticated review page. Optional blank fields
and complete packets do not generate waiting-question alerts. Answering the
questions, resuming, cancellation, and disconnect invalidate pending alerts.
Operational failures with complete answers send a status alert instead of opening
an empty question conversation. The normal five-minute sweep recovers missed
delivery using the existing lease, version and retry protections.

Application workers attempt delivery after publishing waiting packets and after
preparation stops for user attention. Newly confirmed connections enqueue existing
waiting applications and attention alerts. Database leases,
version checks, five-attempt backoff and safe error codes protect delivery. A lost
send response can duplicate a notification; it cannot approve or submit twice.
Vercel Cron calls `/api/notifications/telegram/sweep` every five minutes with
CRON_SECRET, independently of the daily auto-apply sweep. Attention delivery runs
before submission dispatch and review recovery, checks up to 20 due alerts within
a one-minute loop budget, and backs off transport failures for at most five
attempts. A replay skips delivered alerts; a lost Telegram response can still
duplicate an alert. Application changes and disconnects invalidate stale claims.
Old review snapshots and replay IDs are removed after seven days. Account/application deletion cascades
their records. The connector does not store a separate chat transcript.

Run `node --import tsx --test tests/telegram*.test.ts` for the real PGlite migration,
RLS, account linking, exact revisions, duplicate updates, approval/dispatch,
synthetic database receipt, sender isolation, authenticated webhook and outbound
transport checks. Then run lint, typecheck and the production build.

For live acceptance, use a generated test account and the synthetic employer
harness, link a real Telegram test user, edit and confirm one question, approve
continuation and verify one employer-harness receipt. Replay a callback and verify
there is still one receipt. Do not use a real employer or the user's resume for QA.
Local checks do not establish hosted migrations, Telegram delivery or live browser
success. Those results must be reported separately.

References: [BotFather setup](https://core.telegram.org/bots/features#botfather),
[deep links](https://core.telegram.org/bots/features#deep-linking),
[webhook authentication](https://core.telegram.org/bots/api#setwebhook).

## Continuation update on 2026-11-03

Apply `202611030046_telegram_application_continuation.sql` before this release.
It is independent of the unshipped account-queue migration 045. Review selection
uses service-only RPCs bound to the linked private sender, application ownership,
revision and incoming update ID. Delivery and answer transitions use the same
selected-request ordering. Other pending conversations and their answers remain
saved. Preparation retries use the existing quota-checked RPC, clear previous
automatic permission, persist queued intent before dispatch and return to explicit
review. The existing claim-based recovery handles a lost dispatch response.
Any previous send intent, recorded receipt or uncertain outcome denies a retry.

Browser alerts now offer **Open live employer browser** and **Check status**.
A verified callback obtains the original active session through the same
owner/revision/deadline checks used by the app. Only then does it mint a 60-second
provider link for that connected private chat; the connection is checked again
before sending. The URL stays in a protected-content button, with previews off;
it is never placed in logs or a permanent notification. Session expiry ends
access. A stale button cannot reopen a session or resend an application. Field
help retains its blocked-write guard and post-help review. Verification and sign-in
still need the live browser; Browserbase's mobile keyboard support is limited.

Local acceptance covers alert routing, selected-job questions, complete resume and
notice review, qualification warnings, receipt text, pagination, stale and
cross-account buttons, expired browser sessions, scoped live links and SQL replay
and retry guards. No real Telegram user or employer is contacted by those tests.
Migration 046 was applied and verified in the existing isolated staging database;
045 remains unapplied. Actual phone interaction with Telegram is still a user
acceptance step.

References: [Telegram inline buttons](https://core.telegram.org/bots/api#inlinekeyboardbutton),
[Browserbase Live View and mobile limits](https://docs.browserbase.com/platform/browser/observability/session-live-view).

Release verification: 522 tests passed in the full bounded-concurrency suite;
33 focused continuation/assistance regressions and the final 13 review/transport
checks passed. ESLint, TypeScript and the staged production build passed. Staged
deployment `dpl_B4dZe31oBopdUP49UyNDt7BeHkXE` is ready. A webhook probe without
the secret was used only to verify authentication; no outbound live Telegram
message or employer submission was generated for acceptance.

## Verification relay on 2026-11-03

Migration `202611030047_telegram_verification_bridge.sql` adds an atomic,
service-only response inbox in the existing private application-task output. It
is independent of migration 045. For a connected Telegram account, verification
uses the original worker's open page and network guards. Browserbase solving and
the optional 2Captcha grid fallback run before human handoff. No second browser
is opened. The task is labeled `telegram_verification_required`; screenshots and
chat controls are accompanied by an owner-checked Live View escape hatch for
unsupported verification prompts.

The bot sends a protected screenshot with form inputs masked. A supported
one-time-code form gets a reply prompt; recognized CAPTCHA frames with
accessible controls get numbered tile/control buttons. The human chooses every
challenge action. No AI model selects CAPTCHA answers. Each response belongs to
one observed view and the linked account, application revision, stage and active
session deadline. Screenshot pixels bind challenge clicks as well as DOM state;
changed pictures and stale buttons require a new prompt. The relay cannot press
an application Submit button. Filling a code is followed by a fresh verification
form check before an observed Verify control is clicked. A replacement page
cannot inherit that click.

Code commands are authenticated-encrypted using a domain-separated key derived
from the existing server-only webhook secret. They are not written to profiles,
logged, or sent to an AI model. A worker claims and removes the queued ciphertext
before applying it; an interrupted action is never replayed. Normal wait cleanup
clears task output, and the notification sweep purges expired relay output even
if a worker died. Telegram itself receives the user's code reply. Receipt-model
screenshots mask all inputs so a code left on the page is not exposed to inference.

An unrecognized screen gets a screenshot explaining that the receipt is
unconfirmed or the verification is unsupported, rather than asserting a human
challenge exists. Passkeys, device-bound checks, inaccessible canvas-only
challenges and password sign-in are not promised as chat-completable. The worker
pauses or records an uncertain result; it never restarts or resends to avoid the
limitation. Existing expired sessions cannot be restored. Ordinary manual field
assistance remains a separate reviewed-field path.

Verification: the generated headless-browser harness exercises an OTP form,
changed/auto-verified pages, expiration, excluded application/password forms,
human-selected frame controls, changing canvas pixels and unsupported screens.
It also runs worker -> Telegram prompt -> authenticated code reply -> encrypted
inbox -> original browser action -> task cleanup with generated transport. No
real Telegram recipient, employer or CAPTCHA is contacted. Run:

```sh
node --import tsx scripts/verify/verify-telegram-verification.mts
node --import tsx --test tests/telegram-verification.test.ts
```

The full regression suite passed 529 tests; the generated browser/relay harness
passed 11 checks. These are local generated acceptance results, not a claim that
every live CAPTCHA or the old Method Financial attempt was completed. Migration
047 was applied to the verified isolated staging database.

## Continuous auto-apply (2026-11-06)

Review summaries no longer include the resume body. They link to the authenticated
application page while retaining the questions, answers and employer notices.
Verification handoffs accept both Browserbase UUIDs and Boat `bx_` session IDs;
the earlier UUID-only check rejected Boat sessions before either the waiting task
or the Telegram code prompt could be published. Automatic code prompts remain
bound to the exact application, revision and Telegram reply message, including
when two applications are waiting for different codes at the same time.

For automatic applications, a valid direct text reply or single-choice answer
confirms that question. Multi-select checkboxes still have a confirm action so
the candidate can finish selecting. Confirming the final required answer commits
the existing scoped review/dispatch transaction immediately; there is no further
**Approve & send** prompt. Manual applications retain explicit final approval.
The app's stored automatic mode is read through the request's application relation,
never from callback data. Version, ownership, snapshot and replay checks remain.
Complete automatic packets encountered by delivery are queued rather than sent
as another review card. A queued result is not reported as employer confirmation.
