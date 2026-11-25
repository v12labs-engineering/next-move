# Ten real applications: 2026-11-04

The candidate authorized ten real applications, use of saved information,
generation of written answers, and Telegram questions. The run began on production
deployment `dpl_FK7njpB59D5TUGfLTAoYCfTrW1bE` and deployed verified fixes during
the trial, ending on `dpl_CoRpvj42J1dYiZeUEriirkPxSNFd`. The final deployment
reached READY and the five changed runtime files matched deployed source hashes.
Previously submitted or uncertain applications were excluded. A run that crosses
the send boundary is never retried automatically. Submission is counted only
with a confirmed receipt.

## Findings during review

1. **Generated factual answers are not reliably grounded.** Infisical preparation
   answered Yes to living in the Americas despite the Hyderabad profile and used
   nine years rather than the current profile's eleven years. G2i received an
   unsupported English proficiency classification and a start date in 2024.
   These were corrected or cleared before approval. The missing proficiency
   answer was routed through Telegram.
2. **Salary units and currencies drift.** Diagrid and CertifyOS preparations
   converted a saved USD salary target to INR without conversion or supporting
   evidence. Their reviews explicitly preserve the saved USD target. Melotech's
   numeric EUR expectation was left for a Telegram answer.
3. **Generated narratives can invent work history.** Diagrid's draft claimed AI
   debugging work at United Health Group that the source resume did not establish.
   It was replaced with an accurately described current Codex project. Unsupported
   quantitative allocations and outcomes were also removed.
4. **Date widgets lose their question labels.** G2i and Melotech date fields were
   both represented as `Pick date...`, sharing a label-derived identity. Read-only
   browser inspection established their real labels: earliest project start date
   and earliest start date. The confirmed fifteen-day notice period was used.
5. **Remote matching overstates geographic eligibility.** The Redox match claimed
   remote work from the candidate's country; the live listing requires US
   residence and work eligibility. Several other listings were country-limited.
   These were screened out before creating applications. This batch also includes
   verified India-remote listings and a Germany sponsorship route.
6. **Resume preparation duplicated the source.** The Infisical packet repeated
   the complete source under both relevant experience and full resume. Agent-
   reviewed submissions use one copy of the saved resume, with standalone PDF
   extraction dots removed and factual content preserved.
7. **Retries block the account queue.** The FIFO account queue allows one browser
   job at a time. A preparation waiting for retry retains its place ahead of
   ready submissions. n8n exhausted three preparation attempts with provider
   errors. ElevenLabs also entered automatic retry. These are not submissions.

The agent reviewed each prepared packet before approving. G2i and Melotech
received missing-input requests through Telegram and subsequently entered the
submission queue through the Telegram approval flow. The generated-form test's
three-second fill does not establish equivalent real-employer throughput.

## Changes deployed during the trial

- Standard, explicitly labeled controls now use complete DOM mapping and the
  existing binding validator before a model call. Unrecognized or ambiguous
  controls retain perception fallback. All required answers, notices, uploaded
  document hashes and final submission checks still run.
- Single-input question wrappers preserve real date labels. Generic dropdown
  placeholders no longer cause an otherwise identical question to lose its
  approved answer. Location recovery accepts only a unique observed equivalent
  city/region/country option or the known country for a generic Location question.
- Unresolved factual questions are withheld from freeform generation after
  saved profile and answer-memory resolution. Narrative grounding is still an
  open issue; the batch's narratives were reviewed separately.
- Automatic runs no longer ask the candidate to repair routine form widgets in
  a live browser. They use bounded recovery and release the queue on exhaustion.
  Genuine verification still uses the Telegram bridge. Missing facts use the
  existing durable question flow. This removes a manual widget-repair wait;
  it does not eliminate technical failures or the need for factual input.

Verification included 345 application/Telegram tests at the initial native
mapping change; focused later checks passed 125 tests, and the final location
refinement passed all 106 affected profile/computer tests. Typecheck and targeted
lint passed. Generated Chrome checks covered ordinary controls, iframes, shadow
DOM, conditional questions, multiple steps, missing answers, delayed dropdowns,
date labels and location recovery. All retained the final gate and upload checks.

Real **fill-only** checks reached that gate with submission disabled: Diagrid
4.2 seconds, G2i 15.3 seconds, CertifyOS 14.8 seconds, ElevenLabs 14.5 seconds and
Honeydew 3.5 seconds. These local timings are distinct from deployed measurements.
Production form execution took G2i 19.3 seconds, CertifyOS 18.5 seconds and
ElevenLabs 17.8 seconds with zero mapping perceptions. These numbers exclude
browser startup, receipt detection and CAPTCHA/Telegram waiting time.

## Remaining reliability gaps

Three live solver runs (Diagrid, CertifyOS and ElevenLabs) stopped with
`view_changed` during tile clicks or grid verification. The guarded solver did
not act on an unverified replacement image, but automatic completion was not
achieved. The Telegram windows expired without input. The exact cause of those
view changes is not established; removing the freshness checks is not a fix.

G2i and Honeydew each clicked Submit once and failed receipt inspection within a
few seconds. Their results remain unknown; no repeat send was attempted. Browser
recording and session logging are disabled by the session configuration, so no
retained replay is available to independently recover these outcomes.
Melotech's latest live
fill stopped on native perception/provider failure (including an invalid-structure
response), while its local diagnostic exposed additional education questions.
The missing education start year cannot be inferred from graduation year.
Eltropy's failure is not yet classified: the local diagnostic also timed out
waiting for a top-level email input, which alone does not identify the cause.
The n8n preparation exhausted its automatic provider retries.

## Outcome

At the final database check on 2026-11-04 at approximately 18:02 UTC, all ten
attempts had reached a terminal or user-input state. None remained queued,
preparing, running or submitting. **One application has a confirmed receipt,
five have unknown results after the send boundary, three stopped before send,
and one is waiting for factual answers.** This is not ten successful applications.

| Employer | Final result | Evidence or blocker |
| --- | --- | --- |
| [Infisical](https://jobs.ashbyhq.com/infisical/3c9ae12c-142f-408d-8ad8-850addc594ec) | Submitted | Receipt confirmed at 17:42:30.756 UTC: “Your application was successfully submitted. We'll contact you if there are next steps.” |
| [G2i Inc.](https://jobs.ashbyhq.com/g2i/cc84c5e2-d15f-436a-8ccc-b97d813b77a5) | Submission unknown | Submit clicked; receipt inspection failed. Automatic resubmission blocked. |
| [Melotech](https://jobs.ashbyhq.com/melotech/a7d99ee2-75fe-4a12-8f6c-1ecedaa68a3e) | Stopped before send | Latest fill stopped on provider/perception failure. Local diagnostic separately exposed education questions. |
| [n8n](https://jobs.ashbyhq.com/n8n/1af7a193-334d-4d5c-b45d-250122d9c3f1) | Stopped before send | Three preparation attempts exhausted on provider failures; no approved packet or send. |
| [Honeydew](https://jobs.ashbyhq.com/honeydew/3e341a90-91d3-4f2e-a954-36e175758a0c) | Submission unknown | Residence “Other” was observed and restored from the known India residence. Filled, clicked Submit, then receipt inspection failed. |
| [Diagrid](https://jobs.ashbyhq.com/diagrid/06fdf2f3-fff0-4628-b58c-2c07d408e656) | Submission unknown | CAPTCHA solver stopped on a changed view; Telegram verification window expired. |
| [CertifyOS](https://jobs.ashbyhq.com/certifyos/0bcadb51-f3a0-4bfb-8dd7-be3f283c55a7) | Submission unknown | CAPTCHA solver stopped on a changed view; Telegram verification window expired. |
| [Eltropy Inc.](https://job-boards.greenhouse.io/eltropyinc/jobs/4462166009) | Stopped before send | Unclassified fill failure; no submission boundary crossed. |
| [ElevenLabs](https://jobs.ashbyhq.com/elevenlabs/e6924f60-c8cc-42b3-9d05-2442ec30e12d) | Submission unknown | Known country selected correctly; CAPTCHA verification view changed and Telegram window expired. |
| [Juniper Square](https://jobs.ashbyhq.com/junipersquare/dad14b12-09a1-476b-82ba-647167a47a88) | Awaiting answers | Current and expected CTC remain missing. Current Telegram request is pending and its latest version was delivered. |

No confirmed or uncertain application was submitted a second time. The earlier
confirmed Prenuvo application was excluded from this ten-job batch. Private source
snapshots, reviews, task states and the final outcome ledger remain in the ignored
`.local-data/overnight-10/` directory. No verification codes or credentials are
included in this report.
