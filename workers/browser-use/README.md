# Browser Use application worker

The planner uses the open-source Python `browser-use==0.13.14` SDK. With
`APPLICATION_BROWSER_PROVIDER=boat`, the account's applications reuse one private
Boat VM for a batch. Browser Use, Chrome and the 2Captcha solver run on the VM.
Next.js owns saved answers, quotas, submission intent and receipt persistence.

## Boat configuration and deployment

Apply `202611120071_application_boat_batches.sql` before deploying. Set
`BOAT_API_KEY` as a server-only secret and `APPLICATION_BROWSER_PROVIDER=boat` on
the Next.js project. Set `BOAT_APPLICATION_BATCHING=false` to restore one VM per
browser session. Standalone diagnostic scripts also use one VM per session.

A VM starts when the first application needs a browser. Next.js uploads the
Python worker and compiled CAPTCHA worker, and Boat installs their dependencies
once for the batch. `BOAT_BROWSER_SNAPSHOT` can point to a prepared template.
Each batch VM uses a private hosted port, `noEnv: true` and a 30-minute auto-stop.

The account's two browser slots each get a fresh Chrome process and profile,
loopback CDP endpoint, virtual display, recording, upload directory and worker
token. The gateway requires Boat's access cookie and application-scoped worker
credentials. Browser Use and CAPTCHA connect only to the assigned Chrome process.
Closing an attempt stops its processes and removes its uploads and profile.

The application workflow checks idle batches every 15 seconds while a browser is
active. It stops an idle VM after 45 seconds, with up to 90 seconds total idle
time when another application is ready. OTP waits keep the active lease for the
existing verification window, up to three minutes. Browser leases expire at the
application deadline plus 20 seconds of cleanup time. When a new session cannot
fit within the remaining VM lifetime, the VM drains active sessions and stops.
The existing application recovery cron also checks for missed cleanup. Boat's
API must report the VM stopped before another batch can start for that account.

## Recording

Batch sessions record to `/home/user/application-recordings/<sessionId>.mp4`.
The standalone worker records to `/home/user/application-recording.mp4`. Recordings
include entered application data and stay in the private stopped VM snapshot
under Boat's retention policy. The `Application browser started` and `Application
browser timing` logs identify the `sandboxId` and the recording's `sessionId`.
Keep desktop URLs, credentials and recordings private.

## Local development and rollback

For local Chrome testing, create `.local-data/browser-use-venv` with Python 3.12
and install `requirements.txt`, then set `BROWSER_USE_PYTHON` to that Python.
For the explicit Browserbase rollback path, set
`APPLICATION_BROWSER_PROVIDER=browserbase` and retain the existing
`BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`, `BROWSER_USE_WORKER_URL` and
`BROWSER_USE_WORKER_TOKEN`. No automatic cross-provider fallback occurs.

## Verification

```sh
.local-data/browser-use-venv/bin/python -m unittest discover -s workers/browser-use -p 'test_*.py'
node --import tsx --test tests/application-browser-use.test.ts tests/application-browser-session.test.ts tests/application-computer.test.ts
```

The Python tests use the real SDK's tool registration/validation with network
calls stubbed. The Node tests exercise transport, cancellation, quota denial,
application validation and submission gates. To run the actual SDK and model
against generated HTML in local Chrome using the existing synthetic harness:

```sh
BROWSER_USE_PYTHON="$PWD/.local-data/browser-use-venv/bin/python" \
  node --import tsx scripts/verify/verify-computer-agent.mts \
  --planner=browser-use --native-local --local --form-controls --refresh-oidc
```

That harness requires its existing ignored staging/model environment files.
It uses fictional candidate data and checks a synthetic receiver; it sends no
employer application. Local verification does not deploy the worker or app.

The planner uses DOM text and typed backend tools (`use_vision=False`), without
sending screenshots to the model. Set `BROWSER_USE_MODEL` on the Next.js app to
choose its model independently of resume tailoring; an empty value inherits
`TAILORING_MODEL`. The model must support structured output and tool calling.

## Turn budget, filling order and timing

Apply `202611050054_native_agent_sixty_turns.sql` before deploying the worker.
Both the database constraint/reservation function and Browser Use allow 60 turns;
turn 61 is refused without incrementing or consuming a monthly AI attempt.
The agent transport limit is 720 seconds. Boat caps batch VMs at 30 minutes and
standalone VMs at 900 seconds. Browserbase caps its sessions at 800 seconds.

The agent is instructed to finish each page top to bottom, batch up to eight
native actions, and stop a batch when a dropdown or conditional field changes
page state. It uses the SDK's current DOM snapshot instead of re-inspecting
completed fields. Buttons labelled Next, Continue, Save and continue or Review
advance intermediate pages even when their HTML type is `submit`; automatic send
intent is recorded only for a final-submit control. One consolidated final
validation is allowed per page;
failed actions, validation errors and changed dependent controls allow targeted
reinspection. Unknown required facts still pause rather than being guessed.

`Browser Use timing` logs contain only phase, durations, turn number, success
and (for application sends) application ID/revision. They never contain model
messages, answers, URLs, documents, credentials or DOM content. Worker phases
include `sdk_import`, `agent_ready`, `browser_connect`, `dom_snapshot`, `model`,
`native_action`, business tool names, `reserve_decision`, `first_input` and
`agent_run`. Parent phases include `worker_first_event`, `reserve_database`,
`business_tool` and `worker_total`. Elapsed time is relative to the emitting
process's run start; durations can overlap (for example a native business-tool
action includes its RPC wait), so do not add them together. `first_input` is the
first successful text input, dropdown selection or file upload, not a click.
`worker_first_event` includes connection/process startup and the first measured
worker phase. The existing browser timing log covers overall session lifetime.

Run the production native-agent path with the actual configured model against a
local synthetic form (requires local Chrome, the Python environment and existing
ignored staging credentials):

```sh
node --import tsx scripts/verify/verify-native-agent.mts
```

This asserts visible field order, correct answers/file attachment, untouched
optional consent, no more than one explicit inspection, intent before clicking,
and exactly one locally verified receipt. It records only summary metrics in
`.local-data/native-agent-verification.json`. It does not send an employer
application or change application records.

## CAPTCHA diagnostics and recordings

The explicit Browserbase rollback path enables `recordSession: true`. Recordings
include the rendered application form and entered answers, and are available in
the project's Browserbase session replay for the provider's retention period.
The `Application browser timing` event includes the session ID to find the replay.
Raw browser network/console recording remains disabled (`logSession: false`).
Existing sessions created without recording cannot be recovered retroactively.

The backend detects visible reCAPTCHA frames at every nesting depth. The solver
can activate an observed unchecked reCAPTCHA checkbox and hand its image grid
to 2Captcha; a passive badge or verified checkbox is not treated as a challenge.
An unchecked checkbox does not block initial form loading. Browserbase automatic
solving stays disabled so there is only one solver acting on each challenge.

Verification metadata probes never take screenshots. Image capture remains
mandatory for actual CAPTCHA clicks to reject stale images/solutions. Logs
separate `Application verification probe`, `Application CAPTCHA handoff`, and
provider request/result events. They include only safe phase, outcome, duration,
status and numeric provider error codes. Three no-challenge calls stop the run
rather than looping. Missing configuration and unsupported challenges stop the
solver; the application workflow separately handles the one extra automatic
attempt for an unverifiable send under migration `202611080064`.

Grid encoding/capture occurs once per paid CAPTCHA round. Tile and Verify
validation read metadata only; dynamic replacement polling also skips full-frame
screenshots. Actual clicks retain screenshot fingerprint validation. All rounds
share a four-minute solver budget and a six-task cap, bounded by the caller's
remaining session time. `Application CAPTCHA timing` records capture, validation,
click, replacement and provider phase durations. Run
`node --import tsx scripts/verify/verify-captcha-round.mts` for an isolated Chrome test
with synthetic tiles and mocked provider responses (no employer submission).

An explicit `ERROR_CAPTCHA_UNSOLVABLE` result for an existing task can refresh the
visible reCAPTCHA puzzle once using its observed reload control. The browser
retains the filled form and uploaded resume. The next paid solve requires changed
grid imagery or instructions, and shares the existing time and six-task limits.
Missing keys, empty balances, ambiguous create responses and absent reload
controls cannot trigger this recovery. Run the same harness with `--refresh` to
verify failed solve → fresh puzzle → successful solve, with form input and file
attachment preserved. This is a synthetic test, not a live solver success claim.

For Boat verification, run `node --import tsx scripts/verify/verify-boat-application.mts`.
It uses the real model and Browser Use against fictional candidate data, including
PDF upload and exactly one synthetic submission. Add `--captcha` for the official
2Captcha reCAPTCHA demo; this requires `TWOCAPTCHA_API_KEY` in the ignored staging
environment. A live success requires a nonempty verified response token.
`node --import tsx scripts/verify/verify-captcha-round.mts --boat` separately checks the
colocated Node worker with synthetic tiles and a mocked provider; it does not
establish that real CAPTCHA challenges can be solved. All harnesses stop their VM.
