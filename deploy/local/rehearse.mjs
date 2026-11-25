import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import {
  closeSync,
  createReadStream,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { createServerClient } from "@supabase/ssr"
import { createClient } from "@supabase/supabase-js"
import { strToU8, zipSync } from "fflate"

const args = process.argv.slice(2)
assert.ok(
  args.length === 0 || (args.length === 1 && args[0] === "--no-build"),
  "Usage: node deploy/local/rehearse.mjs [--no-build]"
)

const root = fileURLToPath(new URL("../../", import.meta.url))
const envFile = resolve(root, ".local-data/compose/local.env")
const dockerEnv = { ...process.env }
for (const key of Object.keys(dockerEnv)) {
  if (key.startsWith("LOCAL_")) delete dockerEnv[key]
}
if (!dockerEnv.DOCKER_CONTEXT && dockerEnv.DOCKER_HOST) {
  assert.match(
    dockerEnv.DOCKER_HOST,
    /^unix:\/\//,
    "Use a local Unix Docker socket"
  )
}
const context = spawnSync(
  "docker",
  ["context", "inspect", "--format", '{{(index .Endpoints "docker").Host}}'],
  { env: dockerEnv, encoding: "utf8" }
)
assert.equal(context.status, 0, "Could not inspect the Docker context")
assert.match(context.stdout, /^unix:\/\//, "Use a local Unix Docker socket")

const init = spawnSync(process.execPath, ["deploy/local/init.mjs"], {
  cwd: root,
  stdio: "inherit",
})
assert.equal(init.status, 0, "Could not generate local credentials")
const env = Object.fromEntries(
  readFileSync(envFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => line.split("=", 2))
)
const url = "http://127.0.0.1:3302"
assert.equal(env.LOCAL_URL, url)
const directory = mkdtempSync(resolve(root, ".local-data/compose/rehearsal-"))
const id = directory.slice(-6).toLowerCase()
const source = `job-search-drill-${id}-source`
const target = `job-search-drill-${id}-restored`
const archive = resolve(directory, "volumes.tar.gz")
const token = randomUUID()
const email = `candidate-${token}@example.test`
const secondEmail = `observer-${token}@example.test`
const password = randomUUID()
const resume =
  "Synthetic Job Search résumé created for the local recovery rehearsal."
const docx = zipSync({
  "word/document.xml": strToU8(
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${resume}</w:t></w:r></w:p></w:body></w:document>`
  ),
})
const bucket = "restore-rehearsal"
const key = `${token}.docx`
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")
async function hashFile(path) {
  const digest = createHash("sha256")
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest("hex")
}
const admin = createClient(url, env.LOCAL_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

function compose(project, args, options = {}) {
  const result = spawnSync(
    "docker",
    [
      "compose",
      "--env-file",
      envFile,
      "-f",
      "deploy/local/compose.yml",
      "-p",
      project,
      ...args,
    ],
    { cwd: root, env: dockerEnv, stdio: "inherit", ...options }
  )
  if (result.error) throw result.error
  assert.equal(result.status, 0, `${project}: ${args[0]} failed`)
  return result.stdout
}

async function checked(request) {
  const { data, error } = await request
  if (error) throw error
  return data
}

function workflow(project, action, runId) {
  const code = `
    fetch("http://127.0.0.1:3000/api/local-restore-test", {
      method: "POST", body: process.argv[1], signal: AbortSignal.timeout(10000)
    }).then(async response => {
      const body = await response.text()
      console.log(JSON.stringify({status: response.status, body}))
    }).catch(error => { console.error(error); process.exitCode = 1 })
  `
  const output = compose(
    project,
    [
      "exec",
      "-T",
      "app",
      "node",
      "-e",
      code,
      JSON.stringify({ action, runId, token, email }),
    ],
    { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" }
  )
  const result = JSON.parse(output)
  assert.ok(
    result.status < 500,
    `Workflow ${action} failed with HTTP ${result.status}`
  )
  return {
    status: result.status,
    data: result.status === 200 ? JSON.parse(result.body) : null,
  }
}

async function waitForWorkflow(project, check) {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    if (check(project)) return
    await delay(500)
  }
  throw new Error("Timed out waiting for Workflow")
}

function browserSession() {
  const jar = new Map()
  const client = createServerClient(url, env.LOCAL_ANON_KEY, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (cookies) => {
        for (const { name, value } of cookies) jar.set(name, value)
      },
    },
  })
  return { client, jar }
}

function cookieHeader(jar) {
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ")
}

async function signIn(userEmail) {
  const { client, jar } = browserSession()
  const { user } = await checked(
    client.auth.signInWithPassword({ email: userEmail, password })
  )
  return { client, user, cookie: cookieHeader(jar) }
}

async function verifyMagicLink(userEmail) {
  const { client, jar } = browserSession()
  await checked(
    client.auth.signInWithOtp({
      email: userEmail,
      options: {
        emailRedirectTo: `${url}/auth/callback`,
      },
    })
  )
  const mailbox = "http://127.0.0.1:3303"
  let message
  for (let attempt = 0; attempt < 20; attempt++) {
    const response = await fetch(`${mailbox}/api/v1/messages`)
    assert.equal(response.status, 200, "Local mail inbox")
    const { messages } = await response.json()
    message = messages.find(({ To }) =>
      To.some(({ Address }) => Address === userEmail)
    )
    if (message) break
    await delay(250)
  }
  assert.ok(message, "The restored stack must deliver a local sign-in email")
  const messageResponse = await fetch(`${mailbox}/api/v1/message/${message.ID}`)
  assert.equal(messageResponse.status, 200)
  const { HTML } = await messageResponse.json()
  const href = HTML.match(/href="([^"]+)"/)?.[1].replaceAll("&amp;", "&")
  assert.ok(href, "Email contains a sign-in link")
  const link = new URL(href)
  assert.equal(link.origin, url)
  assert.equal(link.pathname, "/auth/v1/verify")
  const verification = await fetch(link, { redirect: "manual" })
  assert.ok(
    [302, 303].includes(verification.status),
    "Auth verification redirect"
  )
  const callback = new URL(verification.headers.get("location"))
  assert.equal(callback.origin, url)
  assert.equal(callback.pathname, "/auth/callback")
  assert.ok(callback.searchParams.has("code"))
  const completion = await fetch(callback, {
    headers: { cookie: cookieHeader(jar) },
    redirect: "manual",
  })
  assert.equal(completion.status, 307, "App callback redirect")
  const destination = new URL(completion.headers.get("location"))
  assert.equal(destination.origin, url)
  assert.notEqual(destination.pathname, "/sign-in")
  for (const cookie of completion.headers.getSetCookie()) {
    const [name, ...value] = cookie.split(";", 1)[0].split("=")
    jar.set(name, value.join("="))
  }
  return profile(cookieHeader(jar))
}

async function profile(cookie) {
  const response = await fetch(`${url}/api/profile`, { headers: { cookie } })
  assert.equal(response.status, 200, "Signed-in profile API")
  return (await response.json()).profile
}

async function verifyResumeImport(cookie) {
  const text = `${resume} ${resume}`
  const upload = (origin) =>
    fetch(`${url}/api/resume/import`, {
      method: "POST",
      headers: {
        cookie,
        origin,
        "content-type": "application/octet-stream",
        "x-file-name": "synthetic-resume.txt",
      },
      body: text,
    })
  const accepted = await upload(url)
  assert.equal(accepted.status, 200, "Same-origin résumé import")
  assert.equal((await accepted.json()).text, text)

  const rejected = await upload("http://localhost:3000")
  assert.equal(rejected.status, 403, "Internal origin must be rejected")
  assert.equal((await rejected.json()).error, "Invalid request origin.")
}

async function receipt() {
  return checked(
    admin
      .from("application_test_receipts")
      .select("submissions,received_at")
      .eq("token", token)
      .single()
  )
}

async function verifyData(candidateId, observerId, previousSession) {
  assert.equal((await fetch(`${url}/sign-in`)).status, 200)
  assert.equal((await fetch(`${url}/api/profile`)).status, 401)
  assert.equal(
    (await fetch(`${url}/.well-known/workflow/v1/flow`, { method: "POST" }))
      .status,
    404
  )
  assert.equal(
    (await fetch(`${url}/api/local-restore-test`, { method: "POST" })).status,
    404
  )
  const candidate = await signIn(email)
  const observer = await signIn(secondEmail)
  assert.equal(candidate.user.id, candidateId)
  assert.equal(observer.user.id, observerId)
  const saved = await profile(candidate.cookie)
  assert.equal(saved.candidate.fullName, "Synthetic Candidate")
  assert.deepEqual(saved.candidate.targetCountries, ["Germany"])
  assert.equal(saved.version, 7)
  assert.equal(await profile(observer.cookie), null)
  const foreignProfiles = await checked(
    observer.client
      .from("account_profiles")
      .select("user_id")
      .eq("user_id", candidateId)
  )
  assert.deepEqual(foreignProfiles, [])
  if (previousSession) assert.deepEqual(await profile(previousSession), saved)
  const file = await checked(admin.storage.from(bucket).download(key))
  assert.equal(hash(Buffer.from(await file.arrayBuffer())), hash(docx))
  const denied = await observer.client.storage.from(bucket).download(key)
  assert.ok(
    denied.error,
    "The private object must remain inaccessible to the observer"
  )
  return candidate.cookie
}

try {
  console.log(
    `Synthetic source project: ${source}\nRehearsal directory: ${directory}`
  )
  if (!args.length) compose(source, ["build", "app"])
  compose(source, ["up", "--wait", "--wait-timeout", "240", "--no-build"])
  const { user: candidate } = await checked(
    admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    })
  )
  const { user: observer } = await checked(
    admin.auth.admin.createUser({
      email: secondEmail,
      password,
      email_confirm: true,
    })
  )
  await checked(
    admin.from("account_profiles").insert({
      user_id: candidate.id,
      version: 7,
      data: {
        fullName: "Synthetic Candidate",
        headline: "Synthetic Platform Engineer",
        currentLocation: null,
        targetRoles: ["Software Engineer"],
        skills: ["PostgreSQL"],
        experienceYears: 3,
        workModes: ["remote"],
        sponsorshipRequired: null,
        excludedCompanies: [],
        resumeText: `${resume} ${resume}`,
      },
    })
  )
  await checked(
    admin
      .from("account_countries")
      .insert({ user_id: candidate.id, country: "Germany" })
  )
  const applicationId = randomUUID()
  await checked(
    admin.from("application_runs").insert({
      id: applicationId,
      user_id: candidate.id,
      target_url: `${url}/application-test/${token}`,
      status: "submitting",
      revision: 1,
      approved_revision: 1,
      approved_packet: {
        fields: [],
        answers: {
          _systemfield_name: "Synthetic Candidate",
          _systemfield_email: email,
          authorization: "Yes",
          referral: "",
        },
        resume,
      },
    })
  )
  await checked(
    admin
      .from("application_test_receipts")
      .insert({ token, application_id: applicationId })
  )
  await checked(admin.storage.createBucket(bucket, { public: false }))
  await checked(
    admin.storage.from(bucket).upload(key, docx, {
      contentType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    })
  )
  const previousSession = await verifyData(candidate.id, observer.id)
  const started = workflow(source, "start")
  assert.equal(started.status, 200)
  const { runId } = started.data
  await waitForWorkflow(
    source,
    (project) => workflow(project, "hook").data?.runId === runId
  )
  assert.deepEqual(await receipt(), { submissions: 0, received_at: null })
  console.log(
    "Source verified. The workflow is waiting and the synthetic employer has zero receipts."
  )

  compose(source, ["stop"])
  const dbExit = compose(
    source,
    ["ps", "-a", "db", "--format", "{{.ExitCode}}"],
    {
      stdio: ["ignore", "pipe", "inherit"],
      encoding: "utf8",
    }
  )
  assert.equal(dbExit.trim(), "0", "PostgreSQL must stop cleanly before backup")
  const output = openSync(archive + ".partial", "wx", 0o600)
  try {
    compose(
      source,
      [
        "run",
        "--rm",
        "--no-deps",
        "-T",
        "archive",
        "tar",
        "-czf",
        "-",
        "-C",
        "/snapshot",
        ".",
      ],
      {
        stdio: ["ignore", output, "inherit"],
      }
    )
  } finally {
    closeSync(output)
  }
  renameSync(archive + ".partial", archive)
  const archiveHash = await hashFile(archive)
  writeFileSync(archive + ".sha256", `${archiveHash}  volumes.tar.gz\n`, {
    mode: 0o600,
  })
  console.log(
    `Cold backup created: ${statSync(archive).size} bytes, SHA-256 ${archiveHash}`
  )

  assert.equal(
    await hashFile(archive),
    archiveHash,
    "Restored archive checksum"
  )
  const restoreStarted = performance.now()
  const input = openSync(archive, "r")
  try {
    compose(
      target,
      [
        "run",
        "--rm",
        "--no-deps",
        "-T",
        "archive",
        "sh",
        "-ec",
        `
      for directory in /snapshot/*; do
        test -z "$(ls -A "$directory")" || { echo "Restore volumes must be empty" >&2; exit 1; }
      done
      tar -xzpf - -C /snapshot
    `,
      ],
      { stdio: [input, "inherit", "inherit"] }
    )
  } finally {
    closeSync(input)
  }
  compose(target, ["up", "--wait", "--wait-timeout", "240", "--no-build"])
  const healthySeconds = ((performance.now() - restoreStarted) / 1000).toFixed(
    1
  )
  await verifyData(candidate.id, observer.id, previousSession)
  await verifyResumeImport(previousSession)
  assert.deepEqual(await receipt(), { submissions: 0, received_at: null })
  assert.equal(workflow(target, "hook").data?.runId, runId)
  assert.equal(workflow(target, "resume").status, 200)
  await waitForWorkflow(target, (project) => {
    const { data } = workflow(project, "status", runId)
    assert.notEqual(data?.status, "failed", "The restored workflow failed")
    if (data?.status !== "completed") return false
    assert.equal(data.result, 200)
    return true
  })
  assert.equal(
    workflow(target, "resume").status,
    404,
    "Duplicate resume must be rejected"
  )
  const received = await receipt()
  assert.equal(received.submissions, 1)
  assert.ok(received.received_at)
  console.log(
    "Restored data verified. The same workflow completed with one synthetic submission."
  )
  assert.equal(
    (await verifyMagicLink(email)).candidate.fullName,
    "Synthetic Candidate"
  )
  assert.equal(await verifyMagicLink(`signup-${token}@example.test`), null)

  writeFileSync(resolve(directory, "demo-login.txt"), `${email}\n`, {
    mode: 0o600,
  })
  const result = {
    source,
    target,
    archive,
    archiveHash,
    archiveBytes: statSync(archive).size,
    restoreToHealthySeconds: Number(healthySeconds),
    workflowRunId: runId,
    storageSha256: hash(docx),
    syntheticSubmissions: received.submissions,
    emailSignInVerified: true,
    emailSignupVerified: true,
  }
  writeFileSync(
    resolve(directory, "result.json"),
    JSON.stringify(result, null, 2) + "\n",
    { mode: 0o600 }
  )
  console.log(JSON.stringify(result, null, 2))
  console.log(`PASS. Restored project ${target} is serving ${url}/sign-in`)
} catch (error) {
  console.error(error)
  for (const project of [target, source]) {
    try {
      compose(project, ["stop"])
    } catch (stopError) {
      console.error(stopError)
    }
  }
  console.error(
    `Rehearsal failed. Kept ${source}, ${target}, and ${directory} for inspection.`
  )
  process.exitCode = 1
}
