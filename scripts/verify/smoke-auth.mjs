import assert from "node:assert/strict"

const base = process.env.SMOKE_BASE_URL ?? "http://localhost:3002"
const cases = [
  ["/api/state", "GET"],
  ["/api/jobs/example-job/description", "GET"],
  ["/api/profile", "GET"],
  ["/api/locations?country=Canada&q=Toronto", "GET"],
  ["/api/profile", "PUT"],
  ["/api/profile/analyze", "POST"],
  ["/api/state/job-status", "PATCH"],
  ["/api/state/tracked-country", "POST"],
  ["/api/resume/import", "POST"],
  ["/api/resumes", "GET"],
  ["/api/resumes", "POST"],
  ["/api/resumes/00000000-0000-4000-8000-000000000001", "PATCH"],
  ["/api/resumes/00000000-0000-4000-8000-000000000001/download", "GET"],
  ["/api/applications", "GET"],
  ["/api/applications", "POST"],
  ["/api/applications/00000000-0000-4000-8000-000000000001", "GET"],
  ["/api/applications/00000000-0000-4000-8000-000000000001", "PATCH"],
  ["/api/applications/00000000-0000-4000-8000-000000000001/approve", "POST"],
  ["/api/applications/00000000-0000-4000-8000-000000000001/resume", "GET"],
]
for (const [path, method] of cases) {
  const response = await fetch(`${base}${path}`, { method, redirect: "manual" })
  assert.equal(
    response.status,
    401,
    `${method} ${path} must reject anonymous requests`
  )
  assert.match(response.headers.get("cache-control") ?? "", /no-store/)
  assert.equal((await response.json()).ok, false)
  console.log(`${method} ${path}: 401`)
}
for (const path of [
  "/jobs",
  "/countries",
  "/applications",
  "/profile",
  "/onboarding",
  "/resumes",
]) {
  // Follow page aliases too: countries and resumes now redirect through their replacements.
  const response = await fetch(`${base}${path}`, { redirect: "follow" })
  assert.equal(
    response.status,
    200,
    `${path} must redirect signed-out visitors`
  )
  assert.equal(response.url, new URL("/sign-in", base).href)
  console.log(`${path}: redirects to sign-in`)
}
const response = await fetch(`${base}/sign-in`)
assert.equal(response.status, 200)
assert.match(await response.text(), /Continue with email/)
const signout = await fetch(`${base}/auth/sign-out`, {
  method: "POST",
  headers: { Origin: "https://untrusted.example" },
})
assert.equal(signout.status, 403)
console.log("Sign-in renders; cross-origin sign-out blocked.")
