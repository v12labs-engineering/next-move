# Browserbase API options for reliable application forms

Checked 4 November 2026 against Browserbase's current first-party documentation.
This is a documentation assessment, not a performance benchmark. No paid API
runs, candidate-data transfers, deployments or account changes were made for
this research. Stagehand API details and the application's current execution
flow are assessed separately by the main investigation.

## Recommendation

Keep Browserbase as the browser infrastructure. The strongest production
direction is an application-owned, bounded form agent using browser/Stagehand
primitives, with independent verification of committed field values and an
application-owned submission gate. This is an architectural inference: swapping
browser hosting does not repair incorrect question meaning or an already
corrupted answer packet.

Benchmark Browserbase's **managed Agents API** as a distinct alternative on
synthetic forms. It can remove our orchestration work, but its current control
and file-input gaps make it premature to treat it as a drop-in replacement for
the job-application worker. Consider **Functions** separately if network latency
and worker duration are limiting execution; they move our code nearer the
browser rather than improving question semantics automatically.

## Complete API-family inventory

The current [official API index](https://docs.browserbase.com/llms.txt) lists
these resource families. This is a family-level inventory, not a claim that
every endpoint was invoked or every entitlement verified on our account.

| Family | Documented operations | Application-form relevance |
| --- | --- | --- |
| Sessions | Create, list, retrieve, update/release | Browser lifecycle and configuration |
| Session artifacts | Live URLs, logs, replay/page playlists, recording-download creation/status, uploads | Debugging, human handoff, documents |
| Agents and runs | Agent CRUD; start/list/get runs; messages; resume; stop | Alternative managed reasoning/action loop |
| Functions | List/get/invoke; versions; builds and logs; invocation status/logs; attached secrets | Host custom execution beside the browser |
| Contexts | Create/get/delete | Persist browser login/site data |
| Downloads | List/get/delete | Retrieve documents or receipts |
| Extensions | Upload/get/delete | Install custom Chrome capabilities |
| Navigation policies | Create/list/get/update/delete | Domain/category navigation controls |
| Certificates | Upload/list/get/delete | Private-proxy certificate configuration |
| Secrets/keypair | Create/list/get/update/delete secrets; keypair | Credentials for Functions |
| Webhooks | Create/list/get/update/delete; rotate signing secret | Function lifecycle notifications |
| Fetch / Search | Fetch page / web search | Read-only discovery and page context |
| Projects | List/get/usage | Configuration and cost accounting |

## Managed Agents: the major alternative worth benchmarking

`POST /v1/agents/runs` (`bb.agents.runs.create`) starts a hosted task. Reusable
Agents hold `systemPrompt` and `resultSchema`; runs supply `task`, variables,
browser settings and optionally `pauseWhen`. Browserbase owns the runtime,
model loop and dedicated browser session. This differs from our code calling
Stagehand primitives. [Agents overview](https://docs.browserbase.com/platform/agents/overview),
[run API](https://docs.browserbase.com/reference/api/run-an-agent).

The built-in tools cover browser interaction, search, filesystem and shell.
The documentation explicitly says custom tools cannot be added and built-ins
cannot be disabled. Consequently, our narrow `fillApprovedField` and
`verifyBeforeSubmit` tools cannot simply replace the managed agent's tools.
A natural-language instruction to stop is useful, but is not evidence of a
hard action authorization boundary. [Execution model](https://docs.browserbase.com/platform/agents/how-it-works).

`pauseWhen` enables `PAUSED` runs for specified input/approval conditions;
without it a run never pauses. A paused browser remains open, but the file
workspace is lost on resume. The guide gives paused-session limits of 15 minutes
on free plans and 60 minutes on paid plans, counted from session creation, and
says stopping a paused run currently returns `409`. These are distinct from
the longer limits of ordinary paid browser sessions.
[Pause/resume guide](https://docs.browserbase.com/platform/agents/pausing-runs).

There is documentation inconsistency to test before integration: the pause
guide says original variables are not retained and must be supplied again,
while the [resume API](https://docs.browserbase.com/reference/api/resume-a-run)
describes merging variables over the original variables. Conservatively send
all variables required for the resumed task and verify actual behavior.

**File-input gap:** Agents currently have no documented API for directly
uploading input files into the agent workspace. They can create and download
files, and downloads are retrievable through the session Downloads API.
This does **not** prove an agent cannot upload a résumé to an employer: a
short-lived approved download URL might provide the document. However, the
reviewed docs do not establish a reliable end-to-end download-then-form-upload
contract, so that requires a separate synthetic probe, including file bytes,
filename, employer acknowledgement and pause/resume behavior.
[Agent files](https://docs.browserbase.com/platform/agents/managing-files).

Runs are polled; messages are cursor-paginated using `since`/`nextSince` and
returned as JSON. The API reference does not document an SSE stream for runs.
Do not confuse the integration guide's conversational use of “stream” with an
SSE response contract. [Message API](https://docs.browserbase.com/reference/api/list-run-messages),
[integration guide](https://docs.browserbase.com/platform/agents/integrate-api-sdk).

The main investigation verified the installed `@browserbasehq/sdk` 2.23.0 has
run create/retrieve/list/messages and `pauseWhen`, but its `Runs` class lacks
resume/stop methods. A spike would need the documented REST endpoints or a
verified SDK upgrade; copying current documentation into the existing SDK
without checking its types is insufficient.

Browserbase's own guidance recommends independent validation because finishing
the action sequence is not the same as achieving the task. Treat `COMPLETED`
and a schema-valid `result` as execution output, not proof that an application
is correctly filled or received. [Agent prompting](https://docs.browserbase.com/platform/agents/how-to-prompt-agents).

The dashboard's Optimize feature analyzes past runs and suggests prompt changes;
it also generates a Stagehand script from a successful run. These are useful
for exploring a workflow and making it reproducible, not automatic evidence of
cross-site reliability. [Optimize](https://docs.browserbase.com/platform/agents/optimizing-agents),
[script generation](https://docs.browserbase.com/platform/agents/generating-scripts).

## Browser sessions and supporting APIs

| Capability | What it provides | What it does not solve |
| --- | --- | --- |
| [Session configuration](https://docs.browserbase.com/reference/api/create-a-session) | Viewport, extensions, region, timeout, proxies, recording/logging, CAPTCHA and identity settings; CDP connection URL | Form interpretation and answer correctness |
| [Keep alive](https://docs.browserbase.com/platform/browser/long-sessions/keep-alive) | Reconnect to the same browser after a worker disconnect; explicit `REQUEST_RELEASE` ends it | Durable application state or submission idempotency |
| [Contexts](https://docs.browserbase.com/platform/browser/core-features/contexts) | Persist cookies, localStorage, IndexedDB and other browser-profile data across sessions | A guarantee that unsaved form DOM survives a new browser |
| [Live View](https://docs.browserbase.com/platform/browser/observability/session-live-view) | Watch/control a running browser; embed human handoff; per-tab URLs | Automatic repair or a backend submission gate |
| [Uploads](https://docs.browserbase.com/platform/browser/files/uploads) | Playwright `setInputFiles` directly; Session Uploads API and remote file paths for larger files | Proof that the employer processed the attachment successfully |
| [Observability](https://docs.browserbase.com/platform/browser/observability/observability) | Console/network/CDP logs, Stagehand inspection, replay and downloadable recordings | Independent correctness scoring unless we add it |
| [Extensions](https://docs.browserbase.com/platform/browser/core-features/browser-extensions) | Custom Chrome extension installed at browser creation; ZIP with root manifest, up to 100 MB | Universal widget semantics; installation also adds startup time |

Keep alive is useful for targeted recovery and human handoff, but sessions still
expire and continue accruing browser time until released. Contexts should be
isolated by user/site/login; persistence is written when a session closes, with
a synchronization delay before reuse. They should not replace our durable
packet, field ledger or uncertain-submission state machine.
[Keep alive](https://docs.browserbase.com/platform/browser/long-sessions/keep-alive),
[Contexts](https://docs.browserbase.com/platform/browser/core-features/contexts).

`allowedDomains` is a navigation control, not a comprehensive network guard:
Browserbase's official SDK documents enforcement on main-frame navigation only,
not iframes, XHR, scripts or images. Retain our application-level request guard
and submit controls. [Official Sessions SDK source](https://github.com/browserbase/sdk-node/blob/main/src/resources/sessions/sessions.ts).

## Functions: execution placement rather than a new form engine

Deployed Functions accept `POST /v1/functions/{id}/invoke`, respond `202` and
expose invocation status/result/logs. Browser settings can be overridden for
an invocation. Completion/failure can trigger signed webhooks instead of polling.
[Invocation guide](https://docs.browserbase.com/platform/functions/invoke).

Current documented limits: TypeScript; `us-west-2`; timeout 60–900 seconds
(default 900); no persistent storage; 64 KB serialized parameters; 25 MB build
upload; no `keepAlive`. Browserbase closes the browser at terminal invocation
state. These constraints matter for résumé input delivery and a long user
approval pause. A migration must preserve our durable ownership and submission
gate outside the ephemeral function. Co-location may lower browser-RPC latency;
it cannot correct the Phone/Country interpretation by itself.
[Functions limits](https://docs.browserbase.com/platform/functions/limits).

The currently listed webhook events concern Function invocations and builds.
There is no documented general Agent-run webhook subscription in that event
list. Deliveries are signed and retryable, so the receiver must deduplicate and
acknowledge promptly. [Webhook overview](https://docs.browserbase.com/platform/webhooks/overview).

## Access, models and other surfaces

- **CAPTCHA:** built-in solving exposes start/finish/error console events. Hold
  browser actions while solving and verify readiness after completion. This is
  access recovery, separate from correct form filling.
  [CAPTCHA documentation](https://docs.browserbase.com/platform/identity/captcha-solving).
- **Proxies / Verified / Web Bot Auth:** proxies provide managed or custom
  routing, with best-effort location selection. Verified is a Scale-plan
  browser identity feature; Web Bot Auth is beta and only supplies identity
  signals to participating websites. Neither establishes form-answer correctness.
  [Proxies](https://docs.browserbase.com/platform/identity/proxies),
  [Identity](https://docs.browserbase.com/platform/identity/overview).
- **Model Gateway:** Browserbase-hosted Stagehand can route model calls with
  the Browserbase API key; pin a model or allow method-specific defaults.
  Documented provider-price token billing has no additional markup. It is a
  useful model comparison path, not a form engine, and is unavailable for local
  browsers. [Model Gateway](https://docs.browserbase.com/platform/model-gateway/overview).
- **Search / Fetch:** use for URL discovery and read-only context; they are not
  substitutes for the interactive form state. Authenticated Fetch reuses saved
  Context cookies, but JavaScript-dependent pages still need a browser.
  [Fetch](https://docs.browserbase.com/platform/fetch/overview),
  [Search](https://docs.browserbase.com/platform/search/overview),
  [Authenticated Fetch release](https://www.browserbase.com/changelog).
- **MCP / Browse CLI:** alternate delivery surfaces for browser capabilities.
  MCP is Stagehand-backed and currently uses hosted Streamable HTTP; changing
  transport alone does not change our field semantics or verification.
  [MCP](https://docs.browserbase.com/integrations/mcp/introduction),
  [Browse CLI](https://docs.browserbase.com/integrations/skills/browse-cli).
- **Browser Use:** a separate Python SDK integrated with Browserbase using the
  CDP session URL. It is not the same product as Browserbase managed Agents.
  A fair benchmark could keep the same Browserbase infrastructure and change
  only the controller. [Official integration](https://docs.browserbase.com/integrations/browseruse/python).
- **Director:** Browserbase's conversational workflow builder exports Stagehand
  scripts. Treat it as a prototyping surface; the currently documented production
  managed-agent REST interface is `/v1/agents/runs`, not an assumed Director API.
  [Director](https://www.browserbase.com/director),
  [Agents API](https://docs.browserbase.com/reference/api/run-an-agent).

## Cost and experiment boundaries

Two developer diagnostics deserve an immediate trial with synthetic data:

- **Browser trace** is an official installable skill, not a form-filling REST
  API. It attaches a separate CDP observer alongside the existing controller,
  collecting per-page network/console/navigation events, sampled screenshots,
  DOM snapshots and timing indexes. It can attach to an existing session, so
  it need not replace our controller to explain why a dropdown or upload failed.
  Its CDP trace lacks response bodies by default.
  [Browser trace](https://docs.browserbase.com/integrations/skills/browser-trace).
- **Browser to API** analyzes that capture offline and emits a draft OpenAPI
  3.1 document, JavaScript client and coverage report. `browse network on` can
  add response bodies. Schemas inferred from observed samples are not the
  website's guaranteed contract, and redaction requires review. Use this to
  diagnose autocomplete/upload/validation traffic and build realistic fixtures,
  not to silently replace the employer UI with undocumented submission calls.
  [Browser to API](https://docs.browserbase.com/integrations/skills/browser-to-api).

Current public plans list Developer at $20/month and Startup at $99/month,
with 15 and 50 included Agent calls respectively. Functions hosting is described
as free, while browser/proxy/model usage remains relevant. Do not infer an
all-in per-application price from those allocations: the plan table does not
give enough detail for a complete Agent-run overage calculation. Measure actual
browser seconds, tokens, proxy bytes and run charges in a bounded pilot.
Account-specific entitlement and remaining quotas were not queried here.
[Current plans](https://docs.browserbase.com/account/billing/plans).

## Suggested comparison

1. Hold applicant facts and expected final values constant. Use synthetic forms
   covering ordinary inputs, grouped Phone/Country, cleared-search React Select,
   async city autocomplete, conditional fields, multi-step flows, upload parsing,
   duplicate labels, nested frames and late value changes.
2. Compare the current controller with an application-owned scoped field agent
   and Browserbase managed Agents. Add Browser Use only if those first results
   justify the Python deployment cost.
3. Measure correct committed fields, invalid/missing required fields, wrong or
   invented answers, pre-submit completion, retries, latency and cost. Verify
   through an independent DOM/fixture oracle, not the controller's success claim.
4. For managed Agents, separately prove attachment delivery, pause-before-submit,
   resume state, variable handling, and prevention of unauthorized final actions.
   Prompt compliance alone does not establish that last property.
5. Evaluate Functions only after correctness: compare browser-RPC time against
   the present worker, preserving the same controller and test cases.

These are proposed experiments, not completed measurements. No product examined
here provides evidence that any arbitrary form can always be completed correctly.
