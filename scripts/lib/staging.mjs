import { readFile } from "node:fs/promises"
import { parseEnv } from "node:util"
import { resolve } from "node:path"
import { spawnSync } from "node:child_process"

export const privateProjectRef = "jzvgkjmhugogvpanwjyy"

export function assertStagingTarget(
  config,
  env,
  privateRef = privateProjectRef
) {
  const ref = config.supabase.projectRef
  if (
    config.environment !== "staging" ||
    config.supabase.projectName !== "job-search-staging"
  )
    throw new Error(
      "The staging manifest does not identify the isolated staging project."
    )
  if (typeof ref !== "string" || !/^[a-z]{20}$/.test(ref))
    throw new Error(
      "Set supabase.projectRef in staging/project.json after creating the isolated Supabase project."
    )
  if ([privateProjectRef, privateRef].includes(ref))
    throw new Error("Refusing to use the existing private database as staging.")
  const url = new URL(env.NEXT_PUBLIC_SUPABASE_URL ?? "https://missing.invalid")
  if (
    url.origin !== `https://${ref}.supabase.co` ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error(
      "The staging Supabase URL does not match the staging project ref."
    )
  return ref
}

export function redact(text, env) {
  let result = String(text)
  for (const [key, value] of Object.entries(env)) {
    if (/TOKEN|KEY|PASSWORD|SECRET/.test(key) && value && value.length >= 6)
      result = result.split(value).join("[redacted]")
  }
  return result
}

export async function stagingContext() {
  const root = resolve(import.meta.dirname, "../..")
  const config = JSON.parse(
    await readFile(resolve(root, "staging/project.json"), "utf8")
  )
  let values
  try {
    values = parseEnv(
      await readFile(resolve(root, ".env.staging.local"), "utf8")
    )
  } catch {
    throw new Error(
      "Create .env.staging.local from the staging environment template. Existing .env.local is never used for staging credentials."
    )
  }
  const env = { ...process.env, ...values }
  let privateRef = privateProjectRef
  try {
    const privateEnv = parseEnv(
      await readFile(resolve(root, ".env.local"), "utf8")
    )
    const localRef = new URL(
      privateEnv.NEXT_PUBLIC_SUPABASE_URL
    ).hostname.split(".")[0]
    // Local development can now intentionally use the isolated staging DB.
    // Only a distinct local target adds another private-project exclusion;
    // the original privateProjectRef is always forbidden above.
    if (localRef !== config.supabase.projectRef) privateRef = localRef
  } catch {
    /* The original private project ref is still forbidden. */
  }
  const ref = assertStagingTarget(config, values, privateRef)
  return { root, config, env, ref }
}

export async function management(context, path, body) {
  if (!context.env.SUPABASE_ACCESS_TOKEN)
    throw new Error(
      "SUPABASE_ACCESS_TOKEN is missing from .env.staging.local or the current environment. Do not paste it into chat."
    )
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${context.ref}${path}`,
    {
      method: body ? "PATCH" : "GET",
      headers: {
        Authorization: `Bearer ${context.env.SUPABASE_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    }
  )
  if (!response.ok)
    throw new Error(
      `Supabase management request failed (HTTP ${response.status}). Check staging access; credentials were not printed.`
    )
  return response.json()
}

export async function verifiedContext() {
  const context = await stagingContext()
  const projects = JSON.parse(
    runSupabase(
      context,
      ["projects", "list", "--output", "json", "--agent", "yes"],
      false
    ).stdout
  )
  const project = projects.find((p) => p.id === context.ref)
  if (
    !project ||
    project.name !== context.config.supabase.projectName ||
    project.id !== context.ref
  )
    throw new Error(
      "The live Supabase project identity does not match the staging manifest."
    )
  if (project.status !== "ACTIVE_HEALTHY")
    throw new Error(`Staging Supabase is not ready (${project.status}).`)
  return context
}

export function runSupabase(context, args, print = true) {
  const version = context.config.supabase.cliVersion
  if (!/^\d+\.\d+\.\d+$/.test(version ?? ""))
    throw new Error(
      "Set an exact Supabase CLI version in the staging manifest."
    )
  return runCli(
    context,
    "npx",
    ["--yes", `supabase@${version}`, ...args],
    context.root,
    undefined,
    print
  )
}

export function runCli(
  context,
  command,
  args,
  cwd = context.root,
  input,
  print = true
) {
  const result = spawnSync(command, args, {
    cwd,
    env: context.env,
    encoding: "utf8",
    input,
    maxBuffer: 5_000_000,
  })
  if (result.stdout && print)
    process.stdout.write(redact(result.stdout, context.env))
  if (result.stderr) process.stderr.write(redact(result.stderr, context.env))
  if (result.error || result.status !== 0)
    throw new Error(
      `${command} ${args[0]} failed. Resolve the reported step before continuing.`
    )
  return result
}
