# Automatic application browser

The application runner uses the open-source Python Browser Use SDK. The configured
provider is Boat or the explicit Browserbase rollback path; see
[worker setup](../workers/browser-use/README.md) for configuration.
Browser Use owns native browser perception, navigation, clicking, typing,
dropdown selection, scrolling, file uploads, and submission. The backend does
not enumerate controls, map targets, or fill fields in a deterministic loop.
There is no Stagehand dependency or fallback planner.

The agent's business tools retrieve approved/saved answers, report genuinely
missing required facts, delegate CAPTCHA to 2Captcha, record submission intent,
and report an employer receipt. Native resume uploads use approved PDFs staged
in the active browser session's private upload directory.

The backend retains account isolation, monthly decision quotas, public-network
restrictions, approved document generation, durable submission tracking, and
receipt persistence. A native submit click records intent before executing.
Failures after that boundary remain uncertain and cannot be automatically resent.
Receipt text must actually appear on the employer page before being recorded.

Each business-tool request carries the native SDK's current browser target.
CAPTCHA, missing-question inspection, and verification follow native tab switches
and employer popups within the same browser context. A missing/closed target
stops the operation instead of inspecting the original tab or creating a new one.

Email/SMS codes use `request_verification`, which waits on the existing Telegram
verification bridge in the same browser session. Codes are applied by that
bridge and are never stored as reusable answers or returned to the model. The
agent resumes receipt inspection after the verification prompt clears. The
native tool step allows 240 seconds so the three-minute reply window can finish.

For automatic applications, human verification is code-only. The app shows a
Telegram code prompt; the bridge never offers CAPTCHA tiles or live-browser
operation. CAPTCHA is handled by the configured solver and bounded pre-send
retries. A remaining challenge after send intent stays unconfirmed, with no
second send. A challenge that clears into an OTP continues through Telegram.
Repeated CAPTCHA-tool calls when no active challenge is observed stop the
unproductive loop without labeling it a failed CAPTCHA solve. After send intent,
the same-session receipt check still runs; absent evidence remains unconfirmed.
Unsupported sign-in and a missing Telegram connection are explicit failures,
not ordinary saved-answer questions. Codes and passwords reported by the model
as missing questions are rejected before packet persistence.

Automatic applications prepare the approved resume and job/profile context, then
start the native agent with no copied form. In one employer browser session it
reads the live controls, retrieves saved facts, opens dropdowns, fills and submits.
Only genuinely missing required information creates candidate questions. Manual
preparation retains read-only discovery for review. These question records are
candidate data, not selectors or browser execution plans.

Before accepting a missing-answer report, the backend reuses saved answers,
confirmed profile information and account/resume identity. Current profile values
are available after a question pause; explicit answers and reuse opt-outs still
win. Automatic answer-generation failures propagate to the existing retry/limit
policy instead of being mislabeled as missing candidate information.

Before accepting a missing-answer report with an empty fixed-choice list, the
backend asks the same agent to open and inspect the control. Placeholder labels
are excluded. If choices remain unavailable after that inspection, the question
accepts text; no choices or personal answers are invented. Existing packets with
empty dropdowns also accept typed answers in the review UI. The agent maps those
answers to the actual employer options when it resumes.

Verification: `node --import tsx scripts/verify/verify-application-dropdowns.mts` tests
the actual mobile review controls and save payload against intercepted requests.
`node --import tsx scripts/verify/verify-native-agent.mts --agentic` runs the real SDK
and model against a generated form from an empty field list and saved facts,
checking one submit and one receipt. Neither harness contacts an employer.

The Python worker runs beside Chrome in Boat, or on the separate worker connected
to Browserbase through CDP. It uses
DOM-only reasoning (`use_vision=False`) and an independently configured
`BROWSER_USE_MODEL`. See [worker setup](../workers/browser-use/README.md).
