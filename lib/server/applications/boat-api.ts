import { readFile } from "node:fs/promises"
import { join } from "node:path"

type BoatEnvironment = Partial<NodeJS.ProcessEnv>
type BoatResponse = {
  sandbox?: { id?: string; state?: string }
  sandboxes?: { id: string; name: string }[]
  hostedPorts?: { url: string }[]
  url?: string
}

export function boatApi(env: BoatEnvironment, fetcher: typeof fetch = fetch) {
  if (!env.BOAT_API_KEY) throw new Error("Boat browser is not configured")
  return async (
    path: string,
    body?: unknown,
    idempotency?: string,
    timeout = 65_000
  ) => {
    const response = await fetcher(`https://boat.dev/api/v1${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${env.BOAT_API_KEY}`,
        "Content-Type": "application/json",
        ...(idempotency ? { "Idempotency-Key": idempotency } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
      redirect: "error",
    })
    if (!response.ok)
      throw Object.assign(new Error(`Boat API failed (${response.status})`), {
        status: response.status,
      })
    return (await response.json()) as BoatResponse
  }
}

export type BoatApi = ReturnType<typeof boatApi>
export const BOAT_BATCH_TTL_SECONDS = 1800

export async function createBoatBrowser(
  api: BoatApi,
  env: BoatEnvironment,
  token: string,
  idempotency: string,
  batch = false
) {
  const files = await Promise.all(
    [
      "agent.py",
      "server.py",
      "tool_models.py",
      "boat_server.py",
      "requirements.txt",
      "captcha-worker.mjs",
    ].map(async (name) => ({
      path: `application-worker/${name}`,
      content: await readFile(
        join(process.cwd(), "workers/browser-use", name),
        "utf8"
      ),
    }))
  )
  const setup = [
    "cd /home/user/application-worker",
    ...(batch
      ? [
          "(command -v Xvfb >/dev/null || (sudo apt-get update && sudo apt-get install -y xvfb))",
        ]
      : []),
    "uv venv --python 3.12 venv",
    "uv pip install --python venv/bin/python -r requirements.txt",
    "npm install --no-audit --no-fund --ignore-scripts playwright-core@1.64.1 zod@4.6.7 > /tmp/application-node-install.log 2>&1",
    "exec ./venv/bin/uvicorn boat_server:app --host 0.0.0.0 --port 8080 > /tmp/application-worker.log 2>&1",
  ].join(" && ")
  const created = await api(
    "/sandboxes",
    {
      ...(env.BOAT_BROWSER_SNAPSHOT ? { from: env.BOAT_BROWSER_SNAPSHOT } : {}),
      type: "default",
      ttlSeconds: batch ? BOAT_BATCH_TTL_SECONDS : 900,
      name: batch
        ? `job-search-application-batch-${idempotency}`
        : "job-search-application",
      noEnv: true,
      visibility: "private",
      monitoring: false,
      env: {
        BROWSER_USE_WORKER_TOKEN: token,
        ...(batch ? { BOAT_BATCH: "1" } : {}),
      },
      files,
      setupScript: setup,
      hostedPorts: [{ port: 8080, title: "Application worker" }],
    },
    idempotency
  )
  const id = created.sandbox?.id
  if (!id || !/^bx_[a-z0-9]{8}$/.test(id))
    throw new Error("Boat returned an invalid session")
  return { id, url: created.hostedPorts?.[0]?.url }
}

export function boatWorkerAddress(url?: string) {
  const address = new URL(url || "")
  if (
    address.protocol !== "https:" ||
    !address.hostname.endsWith(".on.boat.dev") ||
    address.username ||
    address.password
  )
    throw new Error("Boat returned an invalid worker URL")
  return address
}

export async function hostBoatWorker(
  api: BoatApi,
  sandbox: { id: string; url?: string }
) {
  return boatWorkerAddress(
    sandbox.url ||
      (
        await api(`/sandboxes/${sandbox.id}/host`, {
          port: 8080,
          title: "Application worker",
        })
      ).url
  )
}
