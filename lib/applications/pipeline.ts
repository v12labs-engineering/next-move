// Sending may use 770s of the 800s function lifetime. Reads must allow that
// lifetime plus cleanup before declaring the worker dead. Keep recovery aligned
// with recover_stale_applications' default 15-minute threshold.
export const APPLICATION_SEND_BUDGET_MS = 770_000
export const APPLICATION_SEND_STALE_MS = 900_000

export const applicationStages = {
  load_source: "Load profile and job",
  read_employer_form: "Find and read application form",
  tailor_resume: "Tailor resume and check qualifications",
  validate_packet: "Prepare answers and validate application",
  check_application: "Validate application state",
  fill_employer_form: "Fill employer form",
  submit: "Send application",
  confirm: "Verify employer receipt",
} as const

export type ApplicationStage = keyof typeof applicationStages
export type ApplicationTask = {
  stage: ApplicationStage
  revision: number
  state: "running" | "completed" | "retry_wait" | "blocked" | "failed"
  attempts: number
  error_code: string | null
  message: string
  next_retry_at: string | null
  updated_at: string
}

export const employerAuthRequired = "employer_auth_required"
export const employerAuthMessage =
  "This employer requires sign-in or account creation. Apply manually on the employer’s site."

export function needsManualApplication(
  run: { status: string; revision: number },
  tasks: ApplicationTask[]
) {
  return (
    run.status === "needs_attention" &&
    tasks.some(
      (task) =>
        task.revision === run.revision &&
        task.state === "blocked" &&
        task.error_code === employerAuthRequired
    )
  )
}

// A live employer browser can wait for a person while reading the form, while
// filling it before the submission boundary, or after send intent is recorded.
export const HUMAN_VERIFICATION_WAIT_MS = 180_000
export const assistanceStages = [
  { stage: "read_employer_form", status: "preparing" },
  { stage: "fill_employer_form", status: "running" },
  { stage: "submit", status: "submitting" },
] as const
export type AssistanceStage = (typeof assistanceStages)[number]
export function assistanceStage(stage: string, status: string) {
  return assistanceStages.find(
    (item) => item.stage === stage && item.status === status
  )
}

export const preparationStages = [
  "load_source",
  "read_employer_form",
  "tailor_resume",
  "validate_packet",
] as const
export function canRetryApplicationStep(
  task: ApplicationTask,
  run: { status: string; revision: number; prepare_attempts?: number }
) {
  return (
    run.status === "needs_attention" &&
    (run.prepare_attempts === undefined || run.prepare_attempts < 3) &&
    task.revision === run.revision &&
    task.error_code !== employerAuthRequired &&
    preparationStages.some((stage) => stage === task.stage) &&
    ["blocked", "failed"].includes(task.state)
  )
}

// Review edits create a new revision but retain the prepared packet. Show the
// actual completed preparation that produced it, rather than inventing four
// new pending tasks. A fresh preparation always uses its own revision only.
export function applicationProgressTask(
  tasks: ApplicationTask[],
  stage: string,
  run: { revision: number; status: string; packet: unknown }
) {
  const current = tasks.find(
    (task) => task.stage === stage && task.revision === run.revision
  )
  if (current) return current
  if (
    !run.packet ||
    ![
      "ready",
      "queued",
      "running",
      "submitting",
      "submitted",
      "submission_unknown",
      "cancelled",
    ].includes(run.status)
  )
    return undefined
  if (
    ![
      "load_source",
      "read_employer_form",
      "tailor_resume",
      "validate_packet",
    ].includes(stage)
  )
    return undefined
  const preparedRevision = Math.max(
    0,
    ...tasks
      .filter(
        (task) =>
          task.stage === "validate_packet" &&
          task.state === "completed" &&
          task.revision <= run.revision
      )
      .map((task) => task.revision)
  )
  return tasks.find(
    (task) =>
      task.stage === stage &&
      task.revision === preparedRevision &&
      task.state === "completed"
  )
}

// Permission/revision/duplicate checks run inside sending, not as a separate
// user approval step. Surface a failed internal check under form preparation.
export function applicationProgressSteps(
  tasks: ApplicationTask[],
  run: {
    revision: number
    status: string
    packet: unknown
    automatic?: boolean
  }
) {
  const check = applicationProgressTask(tasks, "check_application", run)
  return Object.entries(applicationStages)
    .filter(
      ([stage]) =>
        stage !== "check_application" &&
        !(
          stage === "read_employer_form" &&
          run.automatic &&
          !applicationProgressTask(tasks, stage, run)
        )
    )
    .map(([stage, label]) => ({
      stage,
      label:
        stage === "fill_employer_form" && run.automatic
          ? "Read and fill employer form"
          : label,
      task:
        applicationProgressTask(tasks, stage, run) ??
        (stage === "fill_employer_form" && check?.state !== "completed"
          ? check
          : undefined),
    }))
}

const submissionFailures = {
  employer_rejected:
    "The employer reported that this application was blocked or rejected. Review the employer's response before applying again.",
  receipt_loading:
    "The employer page was still loading when receipt inspection timed out.",
  receipt_unconfirmed:
    "Confirmation is ambiguous: the employer page did not show a verifiable application receipt.",
  receipt_text_mismatch:
    "The receipt check did not return exact visible employer confirmation text.",
  receipt_form_visible:
    "The employer still showed editable application questions after sending started.",
  receipt_changed:
    "The employer page changed during receipt verification; the earlier screen cannot confirm submission.",
  receipt_provider_failed:
    "The receipt verification provider could not complete its check.",
  verification_incomplete:
    "Employer verification or receipt review was not completed in the live browser.",
  verification_unavailable:
    "The employer verification could not be completed through Telegram. Check your Telegram connection and the application status.",
  authentication_unsupported:
    "This employer requires a sign-in method the automatic application runner cannot complete.",
  [employerAuthRequired]: employerAuthMessage,
  receipt_persistence_failed:
    "An employer receipt was verified, but saving that confirmation could not be verified.",
} as const

// Only these static reasons may cross into task messages and operational logs.
// Never attach page text, candidate answers, codes or raw provider errors.
export class ApplicationSubmissionError extends Error {
  constructor(readonly code: keyof typeof submissionFailures) {
    super(submissionFailures[code])
    this.name = "ApplicationSubmissionError"
  }
}

// Raised only after observing a CAPTCHA and exhausting the automatic solver.
// OTP prompts use the existing Telegram bridge instead.
export class ApplicationCaptchaError extends Error {
  constructor() {
    super("The CAPTCHA could not be completed automatically.")
    this.name = "ApplicationCaptchaError"
  }
}

export function canQueueApplicationRetry(code: string) {
  return [
    "captcha_unresolved",
    "temporary_unavailable",
    "rate_limited",
    "invalid_model_response",
    "execution_limit",
  ].includes(code)
}

// Only known temporary errors are retried. Never expose raw provider errors:
// they can include credentials, private form answers or control-session URLs.
export function applicationFailure(error: unknown) {
  if (error instanceof ApplicationCaptchaError)
    return {
      code: "captcha_unresolved",
      message: error.message,
      retryable: true,
    }
  if (error instanceof ApplicationSubmissionError)
    return { code: error.code, message: error.message, retryable: false }
  const value = error as {
    message?: string
    status?: number
    statusCode?: number
    code?: string
    name?: string
  } | null
  const message = typeof value?.message === "string" ? value.message : ""
  const status = value?.statusCode ?? value?.status
  const failure = (code: string, message: string, retryable = false) => ({
    code,
    message,
    retryable,
  })
  if (message === "Employer application cooldown")
    return failure(
      "employer_cooldown",
      "A recent or unconfirmed application to this employer prevents another submission. Review your application history and the employer's waiting period before applying again."
    )
  if (message === "Already applied to this job")
    return failure(
      "duplicate_application",
      "An application to this job already exists. Open it from Applications to continue."
    )
  if (message === "Required employer upload")
    return failure(
      "employer_upload",
      "The employer requires a document upload we cannot provide, such as a portfolio or transcript. Open the employer application to complete it."
    )
  if (
    message === "Employer rejected the uploaded document" ||
    message === "Employer document no longer matches approved upload" ||
    message === "Employer document upload did not finish"
  )
    return failure(
      "employer_upload",
      "The employer did not accept the uploaded document. Check the employer's file requirements, then retry."
    )
  if (message === "Unsupported employer control")
    return failure(
      "unsupported_control",
      "The employer form uses a control we could not reliably fill or verify. Contact support, or open the employer application to complete it directly."
    )
  if (
    value?.name === "AI_NoObjectGeneratedError" ||
    message === "AI returned an unknown source reference." ||
    message === "Selected highlights are too long."
  )
    return failure(
      "invalid_model_response",
      "The AI provider returned an invalid resume selection or structured answer.",
      true
    )
  if (
    value?.code === "configuration" ||
    /not configured|api.key|unauthorized/i.test(message) ||
    status === 401 ||
    status === 403
  )
    return failure(
      "configuration",
      "The application provider needs configuration or access. Contact support."
    )
  if (status === 429)
    return failure(
      "rate_limited",
      "The provider temporarily limited requests.",
      true
    )
  if (
    /^Application computer (?:time budget exceeded|decision budget reached)$/.test(
      message
    )
  )
    return failure(
      "execution_limit",
      "The application assistant could not finish working through the employer form within this attempt. Review the employer form, then retry preparation."
    )
  if (
    /quota|budget|capacity or account limit|(?:daily|monthly).*limit/i.test(
      message
    ) ||
    status === 402
  )
    return failure(
      "processing_limit",
      "The processing allowance or provider account limit was reached. Wait for it to reset or update your limit."
    )
  if (/human verification|captcha|sign.in|login/i.test(message))
    return failure(
      "employer_access",
      "The employer requires sign-in or human verification. Open the employer application to resolve it."
    )
  if (/source unavailable|profile unavailable|job closed/i.test(message))
    return failure(
      "source_unavailable",
      "The saved profile or active job is unavailable. Check your profile and the employer listing."
    )
  if (
    /application (?:entry|form)|ambiguous application|unsupported|final submit|unapproved|approval|cooldown|review employer/i.test(
      message
    )
  )
    return failure(
      "employer_form",
      "The employer application or its restrictions need review. Check the employer form before trying again."
    )
  if (
    value?.code === "temporary_unavailable" ||
    (status && status >= 500 && status <= 599) ||
    /timeout|timed out|ECONNRESET|ETIMEDOUT|fetch failed|connection closed|temporarily unavailable|target (?:page, context or browser )?(?:has been )?closed|browser has been closed|browser has disconnected/i.test(
      message
    ) ||
    value?.name === "TimeoutError"
  )
    return failure(
      "temporary_unavailable",
      "The browser, network or provider was temporarily unavailable.",
      true
    )
  return failure(
    "unexpected_failure",
    "This task could not finish. Retry preparation, or contact support if it fails again."
  )
}

export const PREPARATION_TASK_ATTEMPTS = 3
export function preparationRetryAt(
  attempts: number,
  now = Date.now(),
  code?: string
) {
  const delay =
    code === "captcha_unresolved"
      ? attempts === 1
        ? 300_000
        : 900_000
      : 30_000 * 2 ** (attempts - 1)
  return new Date(now + delay).toISOString()
}
