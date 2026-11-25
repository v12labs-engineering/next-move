import type { supabaseServerClient } from "../supabase-server"
import {
  applicationFailure,
  preparationRetryAt,
  PREPARATION_TASK_ATTEMPTS,
  type ApplicationStage,
} from "@/lib/applications/pipeline"

type Database = ReturnType<typeof supabaseServerClient>
export class ApplicationTasks {
  failure: { message: string; nextRetryAt: string | null } | null = null
  constructor(
    private db: Database,
    private id: string,
    private revision: number,
    private token: string | null
  ) {}

  async record(
    stage: ApplicationStage,
    action: string,
    data: Record<string, unknown> = {}
  ) {
    const result = await this.db.rpc("record_application_task", {
      p_id: this.id,
      p_revision: this.revision,
      p_token: this.token,
      p_stage: stage,
      p_action: action,
      p_data: data,
    })
    if (result.error) throw result.error
    if (!result.data) throw new Error("Application task lease no longer active")
    return result.data as { state: string; attempts: number; output: unknown }
  }

  async run<T>(
    stage: ApplicationStage,
    execute: (attempt: number) => Promise<T>
  ): Promise<T> {
    const task = await this.record(stage, "start")
    if (task.state === "completed") return task.output as T
    console.log("Application task started", {
      id: this.id,
      stage,
      attempt: task.attempts,
    })
    try {
      const output = await execute(task.attempts)
      await this.record(stage, "complete", { output })
      return output
    } catch (error) {
      const failure = applicationFailure(error)
      const nextRetryAt =
        failure.retryable && task.attempts < PREPARATION_TASK_ATTEMPTS
          ? preparationRetryAt(task.attempts, Date.now(), failure.code)
          : null
      const message =
        failure.message +
        (nextRetryAt
          ? " Preparation will retry this task automatically; nothing has been submitted."
          : failure.retryable
            ? " Automatic retries are exhausted. Review and retry preparation; nothing has been submitted."
            : " Nothing has been submitted.")
      await this.record(stage, "fail", {
        state: nextRetryAt
          ? "retry_wait"
          : failure.retryable
            ? "failed"
            : "blocked",
        error_code: failure.code,
        message,
        next_retry_at: nextRetryAt,
      })
      this.failure = { message, nextRetryAt }
      throw error
    }
  }
}
