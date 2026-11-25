import { HttpError } from "@/lib/server/http"

export function resolveTailoringConfig(
  env: Record<string, string | undefined>,
  runtimeOidcToken?: () => string | undefined
) {
  const ollamaModel = env.TAILORING_OLLAMA_MODEL?.trim()
  if (ollamaModel) {
    // Docker's host-only Ollama endpoint uses a placeholder API key.
    return {
      baseURL: "http://host.docker.internal:11434/v1",
      apiKey: "ollama",
      modelId: ollamaModel,
      reasoning: "none" as const,
    }
  }

  const baseURL = env.TAILORING_BASE_URL
  const modelId = env.TAILORING_MODEL
  if (!baseURL || !modelId)
    throw new HttpError(503, "AI resume features are not configured yet.")
  let url: URL
  try {
    url = new URL(baseURL)
  } catch {
    throw new HttpError(
      503,
      "The tailoring provider is not configured correctly."
    )
  }
  if (
    url.username ||
    url.password ||
    !["http:", "https:"].includes(url.protocol)
  )
    throw new HttpError(
      503,
      "The tailoring provider is not configured correctly."
    )
  if (env.NODE_ENV === "production" && url.protocol !== "https:")
    throw new HttpError(503, "Tailoring requires a secure provider endpoint.")
  const isGateway =
    url.origin === "https://ai-gateway.vercel.sh" &&
    /^\/v1\/?$/.test(url.pathname) &&
    !url.search &&
    !url.hash
  const apiKey =
    env.TAILORING_API_KEY ||
    (isGateway
      ? env.AI_GATEWAY_API_KEY || env.VERCEL_OIDC_TOKEN || runtimeOidcToken?.()
      : undefined)
  if (!apiKey)
    throw new HttpError(503, "AI resume features are not configured yet.")
  const reasoning: "none" | undefined =
    env.TAILORING_REASONING === "none" ? "none" : undefined
  return { baseURL, apiKey, modelId, reasoning }
}
