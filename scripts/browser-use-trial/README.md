# Browser Use / Browserbase fill-only pilot

This is an isolated experiment, not a production planner. Default modes are fill-only.
The explicitly authorized `prenuvo-submit` mode adds an operator-reviewed submission phase.
Python 3.12, Browser Use 0.13.14, and Playwright 1.64.1 were selected for the pilot.

```sh
uv venv .local-data/browser-use-venv --python python3.12
uv pip install --python .local-data/browser-use-venv/bin/python -r scripts/browser-use-trial/requirements.txt
.local-data/browser-use-venv/bin/python scripts/browser-use-trial/trial.py synthetic
```

The driver requires a fresh Browserbase session in the ignored, private file
`.local-data/browser-use-trial/session.json` with `id` and `connectUrl`, plus
`OPENAI_API_KEY`, `OPENAI_BASE_URL`, and `BROWSER_USE_MODEL` in the environment.
The caller owns session creation and API release, including after failure.
Never commit session credentials, candidate data, screenshots, or raw agent logs.
Redirect stdout/stderr to a private file because Browser Use logs observations.

`synthetic` serves fictional HTML through Playwright interception in the remote
browser: an embedded form, phone country/number, a delayed city picker whose
search text clears after selection, eligibility, and a file input. The verifier
reads committed values independently of the agent's completion claim.

`prenuvo` is scoped to the previously approved application snapshot under
`.local-data/prenuvo-fill-existing.json` and the PDF generated from its approved
resume under `.local-data/browser-use-trial/resume.pdf`. It requires that exact
packet still equal its approved packet. No application records are written.
The known corrupt country answer is excluded; the approved phone's dialing code
is provided instead. Optional unanswered questions stay unanswered.

Both modes first test submission interception against fictional data. Submit
clicks, form submit events, native submit/requestSubmit calls, and network writes
are blocked during filling. A single POST to the observed Greenhouse S3 upload
bucket is permitted within 20 seconds of attaching the approved résumé, only from
the Greenhouse frame and with multipart content. Other writes stay blocked.
Do not interpret a selected file as a completed employer upload; check its response.
The agent cannot run JavaScript, search the web, read local files, or choose
arbitrary upload files. A narrow adapter attaches only the approved resume bytes.

Reports, progress, and screenshots go to `.local-data/browser-use-trial/`.
`agentClaimsSuccess` is not the acceptance criterion. Check the independent
`oraclePassed` for synthetic runs and inspect actual form evidence for Prenuvo.

## Explicit submission mode

`prenuvo-submit` additionally requires `PRENUVO_SUBMISSION_AUTHORIZED=true` and
stops for independent review before sending. An operator command must match the
current session and a durable `submitting` record. The driver clicks exactly one
visible Submit application button, permits one employer POST plus CAPTCHA requests,
and observes the same browser for confirmation. It never automatically retries a
submission. A missing receipt is an uncertain outcome, not success.

This mode was added only after the user explicitly expanded the pilot from filling
to actual submission and CAPTCHA handling. The test uses the approved résumé and
answers; it must not invent new answers to make the form pass.
