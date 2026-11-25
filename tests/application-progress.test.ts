import assert from "node:assert/strict"
import test from "node:test"
import {
  applicationProgressTask,
  applicationProgressSteps,
  applicationStages,
  canRetryApplicationStep,
  type ApplicationTask,
  type ApplicationStage,
} from "../lib/applications/pipeline"

test("only current failed preparation tasks offer an individual retry", () => {
  const failed = task("tailor_resume", 3, "blocked")
  assert.equal(
    canRetryApplicationStep(failed, {
      revision: 3,
      status: "needs_attention",
      prepare_attempts: 3,
    }),
    false
  )
  assert.equal(
    canRetryApplicationStep(failed, { revision: 3, status: "needs_attention" }),
    true
  )
  for (const status of [
    "queued_prepare",
    "preparing",
    "ready",
    "running",
    "submitting",
    "submission_unknown",
    "submitted",
    "cancelled",
  ])
    assert.equal(
      canRetryApplicationStep(failed, { revision: 3, status }),
      false
    )
  assert.equal(
    canRetryApplicationStep(failed, { revision: 4, status: "needs_attention" }),
    false
  )
  assert.equal(
    canRetryApplicationStep(task("submit", 3, "blocked"), {
      revision: 3,
      status: "needs_attention",
    }),
    false
  )
  assert.equal(
    canRetryApplicationStep(task("tailor_resume", 3), {
      revision: 3,
      status: "needs_attention",
    }),
    false
  )
})
const task = (
  stage: ApplicationStage,
  revision: number,
  state: ApplicationTask["state"] = "completed"
): ApplicationTask => ({
  stage,
  revision,
  state,
  attempts: 1,
  error_code: null,
  message: "",
  next_retry_at: null,
  updated_at: "2026-11-02T00:00:00Z",
})
const prepared = [
  "load_source",
  "read_employer_form",
  "tailor_resume",
  "validate_packet",
].map((stage) => task(stage as ApplicationStage, 2))

test("native automatic applications do not show a separate pending discovery step", () => {
  const tasks = prepared.filter((task) => task.stage !== "read_employer_form")
  const steps = applicationProgressSteps(tasks, {
    revision: 2,
    status: "running",
    packet: {},
    automatic: true,
  })
  assert.equal(
    steps.some((step) => step.stage === "read_employer_form"),
    false
  )
  assert.equal(
    steps.find((step) => step.stage === "fill_employer_form")?.label,
    "Read and fill employer form"
  )
  assert.equal(
    applicationProgressSteps(prepared, {
      revision: 2,
      status: "running",
      packet: {},
      automatic: true,
    }).some((step) => step.stage === "read_employer_form"),
    true
  )
})

test("internal send checks are not a separate user step, but their failures remain visible", () => {
  const run = { revision: 2, status: "needs_attention", packet: {} }
  const check = {
    ...task("check_application", 2, "blocked"),
    message: "Already applied to this job",
  }
  const steps = applicationProgressSteps([...prepared, check], run)
  assert.equal(steps.length, 7)
  assert.equal(
    steps.some((step) => step.stage === "check_application"),
    false
  )
  assert.equal(
    steps.find((step) => step.stage === "fill_employer_form")?.task,
    check
  )
})

test("approved answer edits retain the actual completed preparation in progress", () => {
  const tasks = [
    ...prepared,
    ...["check_application", "fill_employer_form", "submit", "confirm"].map(
      (stage) => task(stage as ApplicationStage, 3)
    ),
  ]
  const run = { revision: 3, status: "submitted", packet: {} }
  for (const stage of Object.keys(applicationStages))
    assert.equal(applicationProgressTask(tasks, stage, run)?.state, "completed")
  assert.equal(applicationProgressTask(tasks, "load_source", run)?.revision, 2)
  assert.equal(applicationProgressTask(tasks, "submit", run)?.revision, 3)
})
test("fresh preparation or a missing packet cannot borrow old completed work", () => {
  for (const status of ["queued_prepare", "preparing", "needs_attention"])
    assert.equal(
      applicationProgressTask(prepared, "load_source", {
        revision: 3,
        status,
        packet: {},
      }),
      undefined
    )
  assert.equal(
    applicationProgressTask(prepared, "load_source", {
      revision: 3,
      status: "submitted",
      packet: null,
    }),
    undefined
  )
  const running = task("load_source", 3, "running")
  assert.equal(
    applicationProgressTask([...prepared, running], "load_source", {
      revision: 3,
      status: "preparing",
      packet: {},
    }),
    running
  )
})
test("progress never mixes preparation generations or hides a current failure", () => {
  const tasks = [
    ...prepared,
    task("validate_packet", 4),
    task("read_employer_form", 4),
    task("tailor_resume", 5, "blocked"),
  ]
  const run = { revision: 5, status: "ready", packet: {} }
  assert.equal(applicationProgressTask(tasks, "load_source", run), undefined)
  assert.equal(
    applicationProgressTask(tasks, "read_employer_form", run)?.revision,
    4
  )
  assert.equal(
    applicationProgressTask(tasks, "tailor_resume", run)?.state,
    "blocked"
  )
  assert.equal(applicationProgressTask(tasks, "submit", run), undefined)
})
