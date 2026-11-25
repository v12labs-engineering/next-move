import assert from "node:assert/strict"
import test from "node:test"
import { resolveTailoringConfig } from "@/lib/server/tailoring/config"

test("local Ollama uses the Docker host endpoint without cloud credentials", () => {
  assert.deepEqual(
    resolveTailoringConfig(
      {
        NODE_ENV: "production",
        TAILORING_OLLAMA_MODEL: "granite4.2:8b",
        TAILORING_API_KEY: "cloud-only-key",
      },
      () => {
        throw new Error("Ollama must not read cloud credentials")
      }
    ),
    {
      baseURL: "http://host.docker.internal:11434/v1",
      apiKey: "ollama",
      modelId: "granite4.2:8b",
      reasoning: "none",
    }
  )
})

test("cost-controlled deployments can disable reasoning without changing other models by default", () => {
  const env = {
    TAILORING_BASE_URL: "https://ai-gateway.vercel.sh/v1",
    TAILORING_MODEL: "provider/model",
    TAILORING_API_KEY: "test",
  }
  assert.equal(resolveTailoringConfig(env).reasoning, undefined)
  assert.equal(
    resolveTailoringConfig({ ...env, TAILORING_REASONING: "none" }).reasoning,
    "none"
  )
})

test("deployed Gateway tailoring supports OIDC without a long-lived provider key", () => {
  const config = resolveTailoringConfig({
    TAILORING_BASE_URL: "https://ai-gateway.vercel.sh/v1",
    TAILORING_MODEL: "provider/configured-model",
    VERCEL_OIDC_TOKEN: "test-oidc",
    NODE_ENV: "production",
  })
  assert.equal(config.apiKey, "test-oidc")
})
test("Functions can obtain Gateway credentials from the runtime request context", () => {
  const config = resolveTailoringConfig(
    {
      TAILORING_BASE_URL: "https://ai-gateway.vercel.sh/v1",
      TAILORING_MODEL: "provider/model",
    },
    () => "runtime-token"
  )
  assert.equal(config.apiKey, "runtime-token")
})
test("runtime credentials are never requested for other endpoints or explicit keys", () => {
  const reader = () => {
    throw new Error("Must not read runtime credentials")
  }
  assert.throws(
    () =>
      resolveTailoringConfig(
        {
          TAILORING_BASE_URL: "https://other.example/v1",
          TAILORING_MODEL: "provider/model",
        },
        reader
      ),
    /not configured/
  )
  assert.equal(
    resolveTailoringConfig(
      {
        TAILORING_BASE_URL: "https://ai-gateway.vercel.sh/v1",
        TAILORING_MODEL: "provider/model",
        TAILORING_API_KEY: "explicit",
      },
      reader
    ).apiKey,
    "explicit"
  )
})
test("Gateway credentials are never forwarded to other endpoints", () => {
  for (const base of [
    "https://other.example/v1",
    "https://ai-gateway.vercel.sh.other.example/v1",
    "http://ai-gateway.vercel.sh/v1",
    "https://ai-gateway.vercel.sh/v1/other",
    "https://ai-gateway.vercel.sh:444/v1",
  ]) {
    assert.throws(() =>
      resolveTailoringConfig({
        TAILORING_BASE_URL: base,
        TAILORING_MODEL: "provider/model",
        VERCEL_OIDC_TOKEN: "test-oidc",
      })
    )
  }
})
test("explicit provider credentials take precedence and production requires HTTPS", () => {
  assert.equal(
    resolveTailoringConfig({
      TAILORING_BASE_URL: "https://ai-gateway.vercel.sh/v1",
      TAILORING_MODEL: "provider/model",
      TAILORING_API_KEY: "explicit",
      VERCEL_OIDC_TOKEN: "test-oidc",
    }).apiKey,
    "explicit"
  )
  assert.throws(() =>
    resolveTailoringConfig({
      TAILORING_BASE_URL: "http://localhost:8317/v1",
      TAILORING_MODEL: "local",
      TAILORING_API_KEY: "test",
      NODE_ENV: "production",
    })
  )
})
