import { createHash, randomUUID } from "node:crypto"
import type { Page } from "playwright-core"
import { supabaseServerClient } from "@/lib/server/supabase-server"
import {
  packetSchema,
  missingAnswers,
  suggestExperienceAnswers,
  type ApplicationPacket,
  type ApplicationRun,
} from "@/lib/applications"
import { resumeKeywordTarget } from "@/lib/resume"
import { tailorApplicationResume } from "@/lib/server/tailoring"
import {
  withEmployerBrowser,
  employerAccessGate,
  formHash,
  applicationPauseReason,
  type EmployerHandoff,
} from "./browser"
import {
  discoverNativeForm,
  runNativeApplication,
  nativeAgentDiagnostic,
  type AgentReceipt,
} from "./native-agent"
import { fillApplicationMemory, savedAnswerLibrary } from "./question-memory"
import { waitForApplicationHuman } from "./browser-assistance"
import { waitForBrowserbaseCaptchaIdle } from "./captcha"
import { tryTwoCaptchaGrid } from "./two-captcha"
import { readVerificationView } from "./verification-surface"
import { hasEmployerAccountGate } from "./employer-auth"
import { persistApplicationReceipt } from "./receipt"
import { hydrateCatalogDescriptions } from "@/lib/server/catalog/content"
import { applicationProfileSchema } from "@/lib/applications/profile"
import {
  fillApplicationProfile,
  fillApplicationIdentity,
} from "@/lib/applications/answers"
import { resolvePacketAnswers } from "./answer-resolver"
import { ApplicationTasks } from "./tasks"
import { withAuthenticationAssistance } from "./authentication-guard"
import { notifyApplicationTelegram } from "@/lib/server/telegram/delivery"
import {
  applicationFailure,
  ApplicationCaptchaError,
  ApplicationSubmissionError,
  canQueueApplicationRetry,
  employerAuthRequired,
  assistanceStages,
  type ApplicationStage,
  type AssistanceStage,
  APPLICATION_SEND_BUDGET_MS,
} from "@/lib/applications/pipeline"

// Preparation remains bounded to its original window. Workflow's generated
// maxDuration="max" uses 800s on this Pro project; sending leaves 30s for cleanup
// and persistence, with room for filling and bounded human verification.
const APPLICATION_STEP_BUDGET_MS = 270_000
// Preparation still tailors the resume and resolves answers after discovery.
const PREPARATION_TAIL_MS = 60_000
const SUBMISSION_RESERVE_MS = 75_000
const HUMAN_SUBMISSION_RESERVE_MS = 450_000

const humanStep = (error: unknown) =>
  error instanceof Error && error.message === "Human verification required"

async function resolveAutomaticChallenge(
  page: Page,
  ready: () => Promise<boolean>,
  until: number
) {
  if (await tryTwoCaptchaGrid(page, ready, until)) return true
  await waitForBrowserbaseCaptchaIdle(page, until)
  return await ready()
}

// Hold the same browser for the candidate to sign in or clear a challenge, then
// continue once no access gate is visible. Never used after send intent.
function employerHandoff(
  db: ReturnType<typeof supabaseServerClient>,
  id: string,
  revision: number,
  until: number,
  at: AssistanceStage,
  automatic = false
): EmployerHandoff {
  return async (page, sessionId) => {
    const ready = async () => !(await employerAccessGate(page))
    await withAuthenticationAssistance(page, async () => {
      if ((await employerAccessGate(page)) === "challenge") {
        if (await resolveAutomaticChallenge(page, ready, until)) return
        if (
          !automatic ||
          (await readVerificationView(page, false, false)).mode !== "code"
        )
          throw new ApplicationCaptchaError()
      }
      if (
        automatic &&
        (await readVerificationView(page, false, false)).mode !== "code"
      ) {
        if (await hasEmployerAccountGate(page))
          throw new ApplicationSubmissionError(employerAuthRequired)
        // An optional sign-in can appear beside the guest application.
        // Let the native agent inspect the available paths.
        return
      }
      console.info("Application employer handoff", { id, stage: at.stage })
      await waitForApplicationHuman(
        db,
        id,
        revision,
        sessionId,
        ready,
        until,
        at,
        false,
        page,
        automatic
      )
    })
  }
}

async function discoverApplicationForm(
  url: string,
  job: { title: string; company: string },
  reserveDecision: () => Promise<void>,
  deadline = Infinity,
  handoff?: EmployerHandoff,
  userId?: string
) {
  return withEmployerBrowser(
    url,
    async (page, sessionId) => {
      try {
        return await discoverNativeForm(page, job, reserveDecision, deadline)
      } catch (error) {
        if (!handoff || !humanStep(error)) throw error
        await handoff(page, sessionId)
        return discoverNativeForm(page, job, reserveDecision, deadline)
      }
    },
    handoff,
    userId ? { userId, deadline } : undefined
  )
}

export async function prepareApplication(
  id: string,
  {
    discoverForm = discoverApplicationForm,
    tailorResume = tailorApplicationResume,
  }: {
    discoverForm?: typeof discoverApplicationForm
    tailorResume?: typeof tailorApplicationResume
  } = {}
) {
  const deadline = Date.now() + APPLICATION_STEP_BUDGET_MS
  const db = supabaseServerClient()
  const token = randomUUID()
  const claim = await db
    .rpc("claim_application_preparation", { p_id: id, p_token: token })
    .returns<(ApplicationRun & { user_id: string })[]>()
    .maybeSingle()
  if (claim.error) throw claim.error
  if (!claim.data) return
  const run = claim.data
  const tasks = new ApplicationTasks(db, id, run.revision, token)
  let phase = "load_source"
  try {
    const { profile, email, job, sourceJob } = await tasks.run(
      "load_source",
      async () => {
        const [profile, account, job] = await Promise.all([
          db
            .from("account_profiles")
            .select("data")
            .eq("user_id", run.user_id)
            .single(),
          db.auth.admin.getUserById(run.user_id),
          run.job_id
            ? db
                .from("job_catalog")
                .select(
                  "title,company,country,description,description_ref,is_active"
                )
                .eq("id", run.job_id)
                .single()
            : Promise.resolve({
                data: {
                  title: "Synthetic test engineer",
                  company: "Staging test employer",
                  country: "",
                  description:
                    "Build reliable TypeScript services, SQL databases and production backend APIs.",
                  is_active: true,
                },
                error: null,
              }),
        ])
        if (profile.error) throw profile.error
        if (account.error) throw account.error
        if (job.error) throw job.error
        if (!job.data?.is_active)
          throw new Error("Application source unavailable")
        const [sourceJob] = await hydrateCatalogDescriptions(db, [job.data])
        return {
          profile: profile.data.data,
          email: account.data.user?.email || "",
          job: job.data,
          sourceJob,
        }
      }
    )
    const source = profile.resumeText as string
    // Auto-apply discovers and fills in one native browser session. A separate
    // copied form must not block it before the agent can inspect live controls.
    // Manual preparation retains read-only discovery for candidate review.
    phase = "read_employer_form"
    const form = run.automatic
      ? { fields: [], notices: "" }
      : await tasks.run("read_employer_form", () =>
          discoverForm(
            run.target_url,
            sourceJob,
            () => reserveApplicationDecision(id),
            deadline - PREPARATION_TAIL_MS,
            employerHandoff(
              db,
              id,
              run.revision,
              deadline - PREPARATION_TAIL_MS - 30_000,
              assistanceStages[0]
            ),
            run.user_id
          )
        )
    phase = "tailor_resume"
    // A draft the candidate already tailored and edited for this job wins.
    const tailored = await tasks.run("tailor_resume", async (attempt) => {
      if (attempt > 1) await reserveApplicationDecision(id)
      const draft = run.job_id
        ? await db
            .from("resume_drafts")
            .select("content,evidence")
            .eq("user_id", run.user_id)
            .eq("job_id", run.job_id)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle()
        : null
      if (draft?.error) throw draft.error
      return await tailorResume(
        source,
        sourceJob,
        draft?.data ?? null,
        !!run.automatic
      )
    })
    const coverage = tailored.coverage
    const needsResumeReview =
      !!run.automatic &&
      (coverage?.percent == null || coverage.percent < resumeKeywordTarget)
    const keywordMessage =
      coverage?.percent == null
        ? "Job keyword coverage is unavailable."
        : `Resume matches ${coverage.matched.length} of ${coverage.total} job keywords (${coverage.percent}%). Target ${resumeKeywordTarget}%.${
            coverage.missing.length
              ? ` Missing terms: ${coverage.missing.join(", ")}.`
              : ""
          }`
    const missingRequired =
      tailored.fit && !tailored.fit.meetsRequired ? tailored.fit.missing : null
    // Qualification assessment is advisory. Only actual unanswered employer
    // questions require candidate input; never invent qualifications.
    const suggested = suggestExperienceAnswers(form.fields, tailored.highlights)
    const applicationProfile = profile.applicationProfile
      ? applicationProfileSchema.parse(profile.applicationProfile)
      : undefined
    phase = "validate_packet"
    const packet = await tasks.run("validate_packet", async () => {
      let packet = packetSchema.parse({
        ...form,
        engine: "browser-use",
        answers: {},
        resume: tailored.content,
        title: job.title,
        company: job.company,
        formHash: formHash(form.fields, form.notices),
        tailored: true,
        answerSources: suggested,
        stepNotices: [form.notices],
        applicationContext: {
          country: job.country || "",
          profile: applicationProfile,
          jobDescription: (sourceJob.description || "").slice(0, 12000),
        },
      })
      if (run.automatic) return packet
      packet = await fillApplicationMemory(id, packet)
      packet = fillApplicationProfile(
        packet,
        applicationProfile,
        job.country || ""
      )
      packet = fillApplicationIdentity(packet, {
        fullName: profile.fullName,
        resumeText: source,
        email,
      })
      for (const [fieldId, answer] of Object.entries(suggested))
        if (
          !(fieldId in packet.answers) &&
          !packet.answerReuseBlocked?.includes(fieldId)
        )
          packet.answers[fieldId] = answer
      packet = await resolvePacketAnswers(
        packet,
        () => reserveApplicationDecision(id),
        undefined,
        await savedAnswerLibrary(id, packet)
      )
      return packet
    })
    const saved = await db
      .from("application_runs")
      .update({
        packet,
        status: needsResumeReview ? "needs_attention" : "ready",
        ...(needsResumeReview
          ? { automatic: false, auto_submit_requested_at: null }
          : {}),
        updated_at: new Date().toISOString(),
        message: [
          needsResumeReview
            ? "Auto-apply paused. Retry preparation to load the employer form for manual review."
            : missingAnswers(packet).length
              ? run.automatic
                ? "Answer the missing questions. Auto-apply will then continue automatically."
                : "Review your resume and complete the employer's questions."
              : run.automatic
                ? "Continuing automatically with your saved answers."
                : "Review every field before approving submission.",
          keywordMessage,
          missingRequired
            ? `Not confirmed in your resume: ${missingRequired.join("; ") || "required qualifications"}. Your resume will only include confirmed experience.`
            : "",
        ]
          .filter(Boolean)
          .join(" "),
      })
      .eq("id", id)
      .eq("status", "preparing")
      .eq("preparation_token", token)
      .eq("revision", run.revision)
    if (saved.error) throw saved.error
    if (needsResumeReview || !run.automatic || missingAnswers(packet).length)
      await notifyApplicationTelegram(id)
  } catch (error) {
    console.warn("Application preparation stopped", {
      id,
      revision: run.revision,
      phase,
      code: applicationFailure(error).code,
      type: error instanceof Error ? error.name : "Unknown",
      humanStep:
        error instanceof Error &&
        error.message === "Human verification required",
    })
    const retryAt = tasks.failure?.nextRetryAt ?? null
    const stopped = await db
      .from("application_runs")
      .update({
        status: retryAt ? "queued_prepare" : "needs_attention",
        preparation_token: null,
        message: tasks.failure?.message ?? applicationFailure(error).message,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("status", "preparing")
      .eq("preparation_token", token)
      .eq("revision", run.revision)
    if (stopped.error) throw stopped.error
    if (!retryAt) await notifyApplicationTelegram(id)
    return retryAt
  }
  return null
}
export async function sendApplication(
  id: string,
  revision: number,
  {
    withBrowser = withEmployerBrowser,
    runAgent = runNativeApplication,
  }: {
    withBrowser?: typeof withEmployerBrowser
    runAgent?: typeof runNativeApplication
  } = {}
) {
  // Stay inside the function's execution limit so failures reach the catch
  // below instead of leaving the run in running/submitting.
  const deadline = Date.now() + APPLICATION_SEND_BUDGET_MS
  const db = supabaseServerClient(15_000)
  const claim = await db
    .rpc("claim_application", { p_id: id, p_revision: revision })
    .returns<
      (ApplicationRun & { user_id: string; approved_packet: unknown })[]
    >()
    .maybeSingle()
  if (claim.error) throw claim.error
  if (!claim.data) return
  const run = claim.data
  let crossedBoundary = false
  let stage: ApplicationStage = "check_application"
  const tasks = new ApplicationTasks(db, id, revision, null)
  try {
    await tasks.record(stage, "start")
    const packet = packetSchema.parse(run.approved_packet)
    if (
      JSON.stringify(run.packet) !== JSON.stringify(run.approved_packet) ||
      missingAnswers(packet).length
    )
      throw new Error("Approval is invalid")
    // Enforce the employer's known cooldown against saved application history.
    // A page's informational limit notice alone is not evidence of rejection.
    const previous = await db
      .from("application_runs")
      .select("id,job_id,target_url,employer_key,status,updated_at")
      .eq("user_id", run.user_id)
      .in("status", ["submitted", "submitting", "submission_unknown"])
      .neq("id", id)
    if (previous.error) throw previous.error
    const employerKey = run.employer_key || new URL(run.target_url).hostname
    if (
      employerKey === "n8n" &&
      previous.data.some(
        (p) =>
          (p.employer_key || new URL(p.target_url).hostname) === employerKey &&
          (p.status !== "submitted" ||
            Date.now() - new Date(p.updated_at).getTime() < 15 * 86400000)
      )
    )
      throw new Error("Employer application cooldown")
    // Runs are unique per target URL. The same catalog job can still be
    // reached through another URL; a sent or uncertain one is never repeated.
    if (run.job_id && previous.data.some((p) => p.job_id === run.job_id))
      throw new Error("Already applied to this job")
    if (run.job_id) {
      const job = await db
        .from("job_catalog")
        .select("is_active")
        .eq("id", run.job_id)
        .single()
      if (job.error || !job.data.is_active) throw new Error("Job closed")
    }
    await tasks.record(stage, "complete")
    stage = "fill_employer_form"
    await tasks.record(stage, "start")
    // These reads need no employer browser. Finish them before starting its clock.
    const [profile, identity] = await Promise.all([
      run.automatic
        ? db
            .from("account_profiles")
            .select("data")
            .eq("user_id", run.user_id)
            .single()
        : Promise.resolve(null),
      run.automatic
        ? db.auth.admin.getUserById(run.user_id)
        : Promise.resolve(null),
    ])
    if (profile?.error || identity?.error)
      throw new Error("Profile unavailable")
    const currentApplicationProfile = profile?.data?.data.applicationProfile
      ? applicationProfileSchema.parse(profile.data.data.applicationProfile)
      : undefined
    const fillHandoff = employerHandoff(
      db,
      id,
      revision,
      deadline - HUMAN_SUBMISSION_RESERVE_MS,
      assistanceStages[1],
      !!run.automatic
    )
    await withBrowser(
      run.target_url,
      async (page, sessionId, releaseBrowser) => {
        const options = {
          logContext: { applicationId: id, revision },
          sessionId,
          codeVerificationOnly: !!run.automatic,
          resolveAnswers: async (current: ApplicationPacket) => {
            let resolved: ApplicationPacket = await fillApplicationMemory(
              id,
              current
            )
            if (profile?.data) {
              // Resolve with the same saved identity/profile supplied to the
              // native agent, including updates made while answering questions.
              resolved = fillApplicationProfile(
                resolved,
                currentApplicationProfile,
                current.applicationContext?.country || ""
              )
              resolved = fillApplicationIdentity(resolved, {
                fullName: profile.data.data.fullName,
                resumeText: profile.data.data.resumeText,
                email: identity?.data.user?.email || "",
              })
              resolved = {
                ...resolved,
                applicationContext: {
                  country: current.applicationContext?.country || "",
                  jobDescription:
                    current.applicationContext?.jobDescription || "",
                  profile: currentApplicationProfile,
                },
              }
            }
            return resolvePacketAnswers(
              resolved,
              () => reserveApplicationDecision(id),
              undefined,
              await savedAnswerLibrary(id, resolved),
              { failOnProviderError: !!run.automatic }
            )
          },
          savedAnswers: async () => ({
            savedAnswers: await savedAnswerLibrary(id, packet),
            profile:
              profile?.data?.data.applicationProfile ??
              packet.applicationContext?.profile,
            identity: profile?.data
              ? {
                  fullName: profile.data.data.fullName,
                  email: identity?.data.user?.email || "",
                }
              : undefined,
            resume: packet.resume,
            jobContext: packet.applicationContext,
          }),
          reserveDecision: () => reserveApplicationDecision(id),
          releaseBrowser,
          deadline,
          humanVerification: async (
            ready: () => Promise<boolean>,
            verificationPage = page
          ) => {
            if (
              await resolveAutomaticChallenge(
                verificationPage,
                ready,
                deadline - SUBMISSION_RESERVE_MS
              )
            )
              return
            if (
              (!crossedBoundary || run.automatic) &&
              (await employerAccessGate(verificationPage)) === "challenge"
            )
              throw new ApplicationCaptchaError()
            if (
              run.automatic &&
              (
                await readVerificationView(
                  verificationPage,
                  crossedBoundary,
                  false
                )
              ).mode !== "code"
            )
              throw new ApplicationSubmissionError("verification_unavailable")
            await waitForApplicationHuman(
              db,
              id,
              revision,
              sessionId,
              ready,
              deadline - SUBMISSION_RESERVE_MS,
              crossedBoundary ? assistanceStages[2] : assistanceStages[1],
              false,
              verificationPage,
              !!run.automatic
            )
          },
          beginSubmission: async (latest: ApplicationPacket) => {
            await tasks.record(stage, "complete")
            stage = "submit"
            await tasks.record(stage, "start")
            const sending = await db
              .from("application_runs")
              .update({
                status: "submitting",
                packet: latest,
                approved_packet: latest,
                updated_at: new Date().toISOString(),
              })
              .eq("id", id)
              .eq("status", "running")
              .eq("revision", revision)
              .eq("approved_revision", revision)
              .select("id")
              .maybeSingle()
            if (sending.error || !sending.data)
              throw new Error("Approval no longer active")
            // Persist intent BEFORE clicking. Process death or lost network after this
            // point is uncertain, never an invitation to try sending again.
            crossedBoundary = true
            console.info("Application send intent persisted", { id, revision })
          },
          recordReceipt: async (
            latest: ApplicationPacket,
            confirmation: AgentReceipt
          ) => {
            const receipt = {
              ...confirmation,
              resumeHash: createHash("sha256")
                .update(latest.resume)
                .digest("hex"),
            }
            // A task-panel write must not discard a verified employer receipt.
            await tasks.record(stage, "complete").catch(() =>
              console.warn("Application receipt task update unavailable", {
                id,
                revision,
              })
            )
            stage = "confirm"
            await tasks.record(stage, "start").catch(() =>
              console.warn("Application receipt task update unavailable", {
                id,
                revision,
              })
            )
            await persistApplicationReceipt(db, id, revision, receipt)
            await tasks.record(stage, "complete").catch(() =>
              console.warn("Application receipt task update unavailable", {
                id,
                revision,
              })
            )
          },
        }
        const runFill = async () => {
          try {
            return await runAgent(page, packet, options)
          } catch (error) {
            // Before send intent, a sign-in or challenge can be handed to the
            // candidate and filling restarts. After it, nothing is retried.
            if (crossedBoundary || !humanStep(error)) throw error
            await fillHandoff(page, sessionId)
            return await runAgent(page, packet, options)
          }
        }
        const result = await runFill()
        if (result.needsAnswers) {
          await tasks.record(stage, "fail", {
            state: "blocked",
            error_code: "missing_answers",
            message:
              "The employer asked for more information. Answer the missing questions to continue automatically.",
            next_retry_at: null,
          })
          const paused = await db
            .from("application_runs")
            .update({
              packet: result.packet,
              status: "ready",
              revision: revision + 1,
              approved_packet: null,
              approved_revision: null,
              approved_at: null,
              auto_submit_requested_at: null,
              message:
                "Answer the missing questions below. Auto-apply will then continue and submit for you.",
              updated_at: new Date().toISOString(),
            })
            .eq("id", id)
            .eq("status", "running")
            .eq("revision", revision)
          if (paused.error) throw paused.error
        }
      },
      fillHandoff,
      { userId: run.user_id, deadline }
    )
  } catch (error) {
    const failure = applicationFailure(error)
    const submissionReason = ["unexpected_failure", "execution_limit"].includes(
      failure.code
    )
      ? "The employer receipt could not be verified."
      : failure.message
    await tasks
      .record(stage, "fail", {
        state: "blocked",
        error_code:
          crossedBoundary && failure.code === "unexpected_failure"
            ? "submission_unknown"
            : failure.code,
        message: crossedBoundary
          ? `${submissionReason} Try again to continue with your saved application.`
          : failure.message,
        next_retry_at: null,
      })
      .catch(() =>
        console.warn("Could not record application task failure", { id, stage })
      )
    if (!crossedBoundary && canQueueApplicationRetry(failure.code)) {
      const retry = await db.rpc("queue_application_retry", {
        p_id: id,
        p_revision: revision,
        p_stage: stage,
        p_error_code: failure.code,
        p_message: failure.message,
      })
      if (retry.error) throw retry.error
      if (retry.data) {
        console.info("Application retry queued", {
          id,
          revision,
          code: failure.code,
        })
        return retry.data as { revision: number; retryAt: string }
      }
    }
    console.warn("Application sending stopped", {
      id,
      revision,
      stage,
      code: failure.code,
      diagnostic: nativeAgentDiagnostic(error),
      type: error instanceof Error ? error.name : "DatabaseError",
      reason: crossedBoundary
        ? submissionReason
        : applicationPauseReason(error),
      crossedBoundary,
    })
    const stopped = await db
      .from("application_runs")
      .update({
        status: crossedBoundary ? "submission_unknown" : "needs_attention",
        message: crossedBoundary
          ? "Try again to continue with your saved application."
          : applicationPauseReason(error),
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("revision", revision)
      .in("status", crossedBoundary ? ["submitting"] : ["running"])
      .select("status,revision,retry_after")
      .maybeSingle()
    if (stopped.error) throw stopped.error
    // The database may authorize the single extra attempt atomically with the
    // failure write. Continue through the existing durable workflow timer.
    if (
      stopped.data?.status === "queued" &&
      stopped.data.revision > revision &&
      stopped.data.retry_after
    )
      return {
        revision: stopped.data.revision,
        retryAt: stopped.data.retry_after,
      }
  }
  await notifyApplicationTelegram(id)
}

export async function recoverInterruptedApplicationSubmission(
  id: string,
  revision: number
) {
  const db = supabaseServerClient(15_000)
  const { data: task, error } = await db
    .from("application_tasks")
    .select("stage")
    .eq("application_id", id)
    .eq("revision", revision)
    .eq("state", "running")
    .in("stage", ["check_application", "fill_employer_form"])
    .maybeSingle()
  if (error) throw error
  const message = "The application worker was interrupted before submission."
  if (task) {
    // The RPC changes the revision atomically and refuses the retry once this
    // attempt has a submit checkpoint or crosses the employer send boundary.
    const retry = await db.rpc("queue_application_retry", {
      p_id: id,
      p_revision: revision,
      p_stage: task.stage,
      p_error_code: "temporary_unavailable",
      p_message: message,
    })
    if (retry.error) throw retry.error
    if (retry.data) return retry.data as { revision: number; retryAt: string }
  }
  const stopped = await db
    .from("application_runs")
    .update({
      status: "needs_attention",
      message: `${message} Nothing has been submitted.`,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("revision", revision)
    .eq("status", "running")
    .select("id")
    .maybeSingle()
  if (stopped.error) throw stopped.error
  if (stopped.data) {
    const { error } = await db
      .from("application_tasks")
      .update({
        state: "blocked",
        error_code: "temporary_unavailable",
        message: `${message} Nothing has been submitted.`,
        updated_at: new Date().toISOString(),
      })
      .eq("application_id", id)
      .eq("revision", revision)
      .eq("state", "running")
    if (error) throw error
  }
  return null
}

// Called by the durable preparation workflow. Browser submission remains its own
// non-retrying step; a replay can only queue the same immutable revision once.
export async function queuePreparedAutomaticApplication(id: string) {
  const db = supabaseServerClient()
  const row = await db
    .from("application_runs")
    .select("revision,status,packet,automatic,auto_submit_requested_at")
    .eq("id", id)
    .single()
  if (row.error) throw row.error
  if (row.data.status !== "ready" || !row.data.automatic) return null
  if (!missingAnswers(packetSchema.parse(row.data.packet)).length) {
    const queued = await db.rpc("queue_automatic_application", {
      p_id: id,
      p_revision: row.data.revision,
    })
    if (queued.error) throw queued.error
    if (queued.data) return row.data.revision as number
  }
  // Missing information releases the account queue, while automatic mode
  // remains in force. A confirmed answer can queue the new revision directly.
  const paused = await db
    .from("application_runs")
    .update({ auto_submit_requested_at: null })
    .eq("id", id)
    .eq("status", "ready")
    .eq("revision", row.data.revision)
  if (paused.error) throw paused.error
  return null
}

async function reserveApplicationDecision(id: string) {
  const result = await supabaseServerClient().rpc(
    "reserve_application_decision",
    { p_id: id }
  )
  if (result.error) throw result.error
  if (!result.data) throw new Error("Application decision quota reached")
}
