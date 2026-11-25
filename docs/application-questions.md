# Application questions and saved answers

The automatic browser agent asks only for required information it cannot resolve
from the candidate's saved facts. It reads and fills live employer controls before
reporting missing questions, rather than requiring a copied form up front.
Unanswered required questions pause an application in its existing review packet.
An in-app alert appears across account pages and links directly to the application.
Alerts refresh every 15 seconds while the tab is visible and on focus. They come
from current Postgres packets, with no browser-storage copy, and disappear when
the questions are answered or the application is cancelled. No email, push or
browser notification permission is involved.

New questions, including optional questions left blank, are recorded privately in
`account_application_questions`. Candidate answers are saved when they save or
continue the review. Employer defaults, model text and answers from other accounts
never teach this library. The **Saved answers** page is available from Applications.
Candidates can add, edit or forget an answer there.

New candidate answers default to **Reuse across employers** when the review is
saved or continued, including answers confirmed through Telegram. Editing a
previously prefilled field also saves the candidate's new value. Candidates can
choose **Reuse for this employer** or **Ask again next time** for an answer;
explicit choices survive later edits. Adding an unanswered question's answer in
**Saved answers** also defaults to reuse across employers. Automatic reuse
requires matching normalized question wording, help text, input kind, option values
and destination country. A changed question or option set asks again; semantic
similarity is not enough. Employer-specific answers take precedence over a global
answer. A new global choice replaces the previous global choice for that question
and country. An explicit employer-level **Ask again next time** overrides a global
saved answer. Consent, terms and declarations stay per application and cannot be
configured for automatic reuse.

Saved answers fill only absent answers. An explicit candidate value, including an
empty string or empty checkbox selection, wins. Reuse is checked both during
preparation and when conditional/later-page questions appear. It adds a database
lookup rather than an AI call. Reused answers are identified in the review UI.
The existing revision claims, user authorization, approved resume and submission
receipt checks remain in force. Editing the library affects future fills; it does
not rewrite an existing application's approved packet or receipt.

Apply `202610310003_application_question_memory.sql` before deploying the reader.
Follow it with `202610310004_application_question_preferences.sql`, which separates
an unanswered reuse preference from an explicit per-employer override.
It adds an RLS-protected table, pure question/answer helpers, a question-capture
trigger, a service-only scoped reader, and owner-derived review/library RPCs.
Answer history and reuse choices commit atomically with review edits and optional
continuation; stale edits cannot update the library. Existing unanswered packets
are backfilled without changing their revision, approval or status.

Apply `202611040048_application_answer_reuse_defaults.sql` before releasing the
default-reuse UI. It changes the shared review-save function used by the app and
Telegram, without promoting existing history or changing explicit reuse choices.

Verification covers executable Postgres migration/backfill, RLS and cross-user
denial, exact/context matching, default reuse and explicit limits, stale-edit
rollback, notification resolution, late questions and the agent's saved-answer
hook. Hosted verification uses generated accounts and the synthetic receiver;
it does not submit to an employer or send email.

## Reworded saved facts and handoff

Before asking for missing answers, preparation and the native browser runner
also resolve reworded salary-expectation and total software-experience questions
from the approved saved-answer library. Country and source question units stay
attached to these answers. Free-text salary answers retain their original amount
and stated units; incompatible currency, period, gross/net or explicit base/total
values are not reused. Numeric salary answers require matching units and one
numeric amount. Total software tenure can answer a minimum-years question, but
does not establish experience with a particular technology. Conflicting saved
values remain unresolved. Explicit blanks and employer ask-again overrides win.

When the browser reports missing questions, the server checks the same saved
facts and frozen profile before ending the session. Known answers are returned
to the browser so it can continue; optional unknowns do not cause a handoff.
Qualification warnings are advisory; genuinely missing required answers pause.
Optional contact/marketing consent is excluded from automatic answer generation
unless the candidate has already supplied an answer for this application.

Regression checks: `tests/application-answer-resolver.test.ts`,
`tests/application-question-memory.test.ts` and
`tests/application-native-agent.test.ts`.

## Application activity and recovery

The Applications pipeline refreshes every five seconds while visible and on focus.
`GET /api/applications` supports `filter=all|needs|flight|submitted|cancelled`,
`offset`, and `limit` (1-100, default 50). Filters run on the server; `counts`
cover every owned application and `total` describes the selected filter. Older
waiting applications remain accessible through filters and pagination, and the
sidebar uses the complete needs-attention count.

The automatic sweep first recovers queued automatic preparation and approved
submission dispatches, including accounts whose background auto-apply setting
is off. It pages through records older than one minute and replays the original
run/revision through the existing worker claims. Active workers and uncertain
submissions are never automatically restarted. Existing approval expiry and
revision invalidation still apply. Normal account refreshes also recover queued
work for that account. Recovery does not admit a second application or consume
another preparation place.

For an automatic application, saving a valid last answer continues submission.
The original auto-apply instruction survives answer edits and question pauses;
the exact edited packet is frozen again before sending. The app labels this
**Save & continue**. Manual applications still save for review. A previous send
intent or receipt prevents automatic continuation of the same application.
