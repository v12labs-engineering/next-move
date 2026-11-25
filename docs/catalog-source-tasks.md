# Durable source tasks and receipts

Implemented foundation and bounded worker: migrations
`202611020039_catalog_source_tasks.sql` and `202611020040_catalog_source_worker.sql`,
`lib/server/catalog/source-worker.ts`, and their SQL-backed tests. These are the
first two slices of the [collection architecture](catalog-scale-architecture.md).
No existing cron, collector route or Workflow calls these new operations yet. No Queue SDK,
consumer, automatic source admission or additional cron is installed.

## Storage contract

Apply preceding public-app migrations in order before 039, then 040. The ledger is
additive: source scheduling columns, tasks, persistent request-key mappings,
outbox intents and page/publication receipts. It does not create tasks, enable
sources, rewrite catalogue IDs, change budgets or delete existing history.
`next_due_at` is initialized for directory rows and advances only on successful
task publication; the existing collector ignores this field.

The operations below are service-role-only, SECURITY INVOKER, with RLS and no
customer policies on ledger tables. Customers cannot admit work, read lease
credentials or forge results. No candidate profile, resume or application data
enters the ledger. Only full-inventory sources are admitted; LinkedIn's partial
search windows are explicitly rejected.

| Operation | Contract |
| --- | --- |
| `request_catalog_source_task(source, request_key)` | Atomically creates/joins one active task and writes one outbox intent for new work. Every joining request key remains bound to that task after completion. Reusing an old key returns its old result; a new key after completion can request a new check. |
| `read_catalog_source_task(id)` | Returns task state, current source-run progress and receipt count; null for an unknown ID. |
| `claim_catalog_task_outbox(limit)` | Claims up to 100 due unsent intents with two-minute fenced publisher leases. No external publish occurs inside the transaction. |
| `confirm_catalog_task_outbox(intent, token, message_id)` | Confirms delivery metadata under the matching live lease/generation. Replays of the same confirmed token/message are true; stale confirmations are false. |
| `claim_catalog_source_task(id, generation)` | Atomically claims one attempt and the existing collector's source lease. Returns `claimed=false` for duplicate, stale, deferred, legacy-owned or capacity-blocked deliveries. Terminal tasks return their recorded result. |
| `checkpoint_catalog_source_task(id, token, page, next, jobs, fetched, rejected, requests)` | Commits staged rows, counters, cursor, page receipt and lease renewal together. Replays return the original receipt; changed payloads for an already-committed page are rejected. |
| `finish_catalog_source_task(id, token)` | Uses the existing guarded full-snapshot publisher and atomically commits its receipt, completed task and next source due time. Replaying the committing token returns that exact result. |
| `recover_catalog_source_tasks(limit)` | Recovers expired worker attempts or confirmed-but-undelivered messages older than five minutes, with a new delivery generation and outbox intent. Live source leases and provider retry times prevent takeover. |
| `read_catalog_source_work(id, token)` | Reads only the claimed source, run, staged size and database capacity under the live token. |
| `checkpoint_catalog_source_work(...)` | Applies record, byte and total-page bounds before the existing atomic page checkpoint; a successful new page resets consecutive failures. |
| `release_catalog_source_work(id, token, mode, reason, requests, retry_at)` | Atomically pauses the run, releases both leases, advances delivery generation, records the release receipt and creates a continuation or delayed outbox intent. Failed tasks create no new intent. |

The ledger enforces **one live task worker globally**, using a transaction-level
admission lock. This is separate from the legacy collector. No configurable
parallelism is exposed before shared provider/write
permits are implemented. A partial active-task uniqueness constraint also
prevents two logical tasks for the same source.

Task claims reuse the original source-run implementation, keeping its attempt token
as the final checkpoint/publication fence. A newly admitted task cannot adopt an
unfinished legacy source run. Existing unfinished legacy work must complete
before admission; a legacy worker winning a later race makes task delivery wait.
Migration 040 wraps the legacy `begin_catalog_run` entry point so legacy callers
cannot adopt active ledger work between bounded deliveries or resume a quarantined
failed inventory. Sources without ledger work retain their existing path. Explicit
cohort routing, transport and operator restart/cancellation remain follow-on work;
do not wire both collectors to the same cohort without that cutover.

## Bounded worker

`advanceCollection({ taskId, dispatchGeneration }, options?)` advances one claimed
full-inventory source. It uses the existing ATS readers, retention filters,
optional description archive and complete-snapshot publisher. It reads no global
source directory and starts no matching or application work.

| Limit | Default | Maximum |
| --- | ---: | ---: |
| Pages per delivery | 3 | 10 |
| Pages across the source run | 1,000 | 10,000 |
| Work duration | 120 seconds | 180 seconds |
| ATS requests per delivery, including retries/detail reads | 24 | 100 |
| Bytes per ATS response | 4 MiB | 15,000,000 |
| Staged source records | 10,000 | 100,000 |
| Staged source JSON bytes | 16 MiB | 64 MiB |

Invalid limits fail before claiming. The work-wide abort signal reaches HTTP,
PostgREST and description-object requests. The database factory accepts that signal;
the default client also imposes a 15-second request timeout and disables hidden
database retries. Fetching stops with 30 seconds of headroom; publication requires
15 seconds remaining. A separate bounded client can persist a release after work
cancellation. These bounds are conservative admission limits, not throughput claims.

Page/request/time exhaustion yields a durable continuation after progress. A
failure before progress waits with exponential backoff (at least one minute),
respecting the longer persisted/provider Retry-After time. Five consecutive recorded
retry failures terminate the task; a committed new page resets that streak. Existing
bounded HTTP retries count against the request limit. No durable backoff is spent
sleeping inside the worker.

Invalid or incomplete inventories, access refusals and snapshot/storage limits
produce named failed results. A snapshot still having a cursor at its total-page
cap fails rather than publishing a partial inventory. Prior published jobs remain
active until a valid complete inventory commits. Failed staged runs are preserved
for operator investigation; there is no automatic reset or restart in this slice.

## Replay and crash semantics

- Admission and its outbox intent are one transaction. Failure before commit
  creates neither; failure afterward leaves claimable delivery work.
- A publisher dying before confirming send loses its lease after two minutes.
  Another publisher can retry the same intent. A lost/expired confirmed delivery
  is recovered into a new generation; old messages become harmless.
- Workers and publishers have separate leases. The task/source worker lease lasts
  five minutes and checkpoint commits renew it. Recovery requires both worker
  and source ownership to be free, and respects source retry/backoff state.
- Page receipts are keyed by task/run/page, with a SHA-256 hash of the original
  continuation, jobs and counters. They survive later pages. Reading task progress
  after an ambiguous response identifies the committed cursor; do not refetch and
  overwrite an already-committed page with changed upstream content.
- Receipt insertion failure rolls back the underlying page or catalogue writes.
  Publication can never commit through these operations without its receipt.
- After publication, the queue may redeliver: claim returns the terminal result
  without creating a new run or attempt. Only the token that committed publication
  can replay that publication RPC. Replaced tokens cannot write or claim a receipt
  belonging to the replacement worker.
- Release receipts are keyed by task/attempt token and hash their arguments.
  Repeating the exact release returns its original result even after a replacement
  claims; a changed release cannot alter the replacement's state. Release and its
  next outbox intent roll back together on failure.
- An ambiguous checkpoint, publication or release response is thrown. The worker
  does not guess whether a transaction committed or perform a second mutation.
  Redelivery/recovery reads the durable cursor or terminal receipt. A crash before
  checkpoint may refetch the page; a crash after checkpoint resumes the next page.
- Config fingerprints include source ID, platform, board, employer and optional
  provider config. Changes or disablement fence further writes. Country observations
  and due-time updates do not change source identity. Config replacement/cancellation
  remains follow-on work;
  operators must resolve blocked configuration changes before resuming those tasks.

The ledger keeps durable publication evidence for later matching delivery, but
this slice does not install the matching coalescer or emit Queue messages. The
existing collector and matching path keep their current behavior.

## Capacity and retention

Admission and recovery check conservative headroom against the existing physical
budget and concurrent storage reservations. Checkpoints reserve page plus receipt
headroom; publication reserves snapshot growth plus receipt headroom. Existing
capacity checks, retention filters and source-wide closure rules remain in force.
Replays of already-committed admission/publication return their receipts without
requiring new growth admission. A full budget produces an explicit error and leaves
previous progress intact.

Terminal request mappings and receipts are deliberately retained in this slice.
Automatic pruning is not installed: safe retention must consider outstanding
messages and replay windows before deleting their evidence. Measure ledger/index
size and implement bounded pruning before a large enabled cohort. The existing
400 MiB database allowance and description-object allowance are unchanged.
Small release/control receipts remain writable so capacity exhaustion can record
a terminal stop; the data admission, checkpoint and publication guards remain in force.

## Verification

```sh
node --import tsx --test tests/catalog-source-tasks.test.ts tests/catalog-source-worker.test.ts tests/operator-storage-timeout.test.ts
npm run lint
npm run typecheck
npm test
npm run build
```

Tests execute real SQL with PGlite, including the current public migration chain
and current publication guards. Fault injection uses failed storage triggers and
expired leases at commit points; no live ATS or database is contacted. They cover
joined/repeated requests, duplicate and stale delivery, worker replacement,
request-key replay after completion, page replay after later pages, publication
replay, transaction rollback at all three write points, RLS/permissions, configuration
fencing and budget admission. PGlite serializes queries; cross-session lock/load
acceptance remains a hosted PostgreSQL canary requirement before parallel rollout.
Worker tests exercise the real public migration chain and ATS parsing through a
PostgREST-shaped test transport. They include multi-delivery pagination, internal
HTTP retry accounting, long Retry-After, retry exhaustion, malformed/oversized
responses, staged/total-page limits, legacy ownership, lost mutation acknowledgments,
failed continuation transactions, deadline cancellation and late replaced workers.

Deployment is separate: migrations 039/040 have not been applied remotely by this task,
and no production caller is switched to the ledger. Keep the deployed single
collection path until the delivery adapter and cohort ownership
cutover are implemented and verified.

Focused verification on 2 November 2026: 28 tests passed (11 ledger, 15 worker and
2 transport timeout/cancellation tests), within the full 354-test suite. ESLint,
TypeScript and the production build/function-bundle audit passed. This evidence
does not establish multi-instance hosted throughput or remote migration/deployment.
