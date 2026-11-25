import { createHash } from "node:crypto"

// Fixed labels and numeric values only: no resumes, URLs, user IDs, lease tokens,
// provider bodies or error messages may enter infrastructure logs.
export function matchingMetric(
  stage:
    | "storage"
    | "admission"
    | "metadata"
    | "hydrate"
    | "inference"
    | "checkpoint"
    | "publish"
    | "read"
    | "failed",
  values: Record<string, number | boolean>,
  token?: string
) {
  console.log(
    JSON.stringify({
      event: "matching_metric",
      stage,
      ...(token
        ? {
            build: createHash("sha256")
              .update(token)
              .digest("hex")
              .slice(0, 16),
          }
        : {}),
      ...values,
    })
  )
}

export async function measureMatching<T>(
  stage: Parameters<typeof matchingMetric>[0],
  work: () => Promise<T>,
  token?: string
): Promise<T> {
  const started = performance.now()
  try {
    const result = await work()
    matchingMetric(
      stage,
      { durationMs: Math.round(performance.now() - started), ok: true },
      token
    )
    return result
  } catch (error) {
    matchingMetric(
      stage,
      { durationMs: Math.round(performance.now() - started), ok: false },
      token
    )
    throw error
  }
}
