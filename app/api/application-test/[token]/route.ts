import {
  applicationProfileSchema,
  applicationProfileFresh,
} from "@/lib/applications/profile"
import { fillApplicationProfile } from "@/lib/applications/answers"
import type { ApplicationField } from "@/lib/applications"
import { testResumeMatches } from "@/lib/server/applications/test-document"
import { supabaseServerClient } from "@/lib/server/supabase-server"
import { testHtml, testReceipt } from "@/lib/server/applications/test-employer"
export async function POST(
  request: Request,
  c: { params: Promise<{ token: string }> }
) {
  const { token } = await c.params
  const fixture = await testReceipt(token)
  if (!fixture || fixture.submissions)
    return new Response("Not found or already submitted", { status: 409 })
  if (Number(request.headers.get("content-length")) > 2000000)
    return new Response("Too large", { status: 413 })
  const db = supabaseServerClient()
  const row = await db
    .from("application_runs")
    .select("approved_packet,status,employer_key,revision,automatic")
    .eq("id", fixture.application_id)
    .single()
  if (row.error || row.data.status !== "submitting")
    return new Response("Approval required", { status: 409 })
  const packet = row.data.approved_packet
  const temporalNames = row.data.employer_key === "synthetic-temporal-names"
  // Native discovery assigns its own IDs. Match the fixture's observed labels
  // while retaining support for earlier DOM-engine packets.
  const frozenAnswers: Record<string, string | string[]> = {}
  const answer = (id: string, label: string) => {
    if (id in packet.answers) return packet.answers[id]
    const fields = packet.fields.filter(
      (field: { id: string; label: string }) =>
        field.label.trim().toLowerCase() === label.toLowerCase()
    )
    return fields.length === 1
      ? packet.answers[fields[0].id]
      : fields.length === 0
        ? frozenAnswers[id]
        : undefined
  }
  const hasQuestion = (id: string, label: string) =>
    id in packet.answers ||
    packet.fields.some(
      (field: { id: string; label: string }) =>
        field.id === id ||
        field.label.trim().toLowerCase() === label.toLowerCase()
    )
  // The native runner reports only unresolved questions. For omitted fixture
  // fields, derive expectations from the immutable approved profile, never the
  // account's current profile or the submitted form. Explicit answers (even
  // blank) and questions present in the packet continue to take precedence.
  const frozen = applicationProfileSchema.safeParse(
    packet.applicationContext?.profile
  )
  if (
    row.data.automatic &&
    frozen.success &&
    applicationProfileFresh(frozen.data)
  ) {
    const fields: ApplicationField[] = [
      [
        "_systemfield_name",
        temporalNames ? "Preferred First & Last Name" : "Full name",
      ],
      ["_systemfield_email", "Email"],
      ["authorization", "Do you have the required work authorization?"],
      ...(temporalNames
        ? [
            ["legal-first-name", "Legal First Name"],
            ["legal-last-name", "Legal Last Name"],
            ["linkedin", "LinkedIn Profile"],
          ]
        : []),
    ]
      .filter(([id, label]) => !hasQuestion(id, label))
      .map(([id, label]) => ({
        id,
        // This controlled fixture asks only about current authorization.
        label: id === "authorization" ? "Are you authorized to work?" : label,
        help: "",
        required: true,
        kind: id === "authorization" ? "radio" : "text",
        options: id === "authorization" ? ["Yes", "No"] : [],
      }))
    Object.assign(
      frozenAnswers,
      fillApplicationProfile(
        { ...packet, fields, answers: {} },
        frozen.data,
        packet.applicationContext?.country || ""
      ).answers
    )
  }
  const needsName =
    row.data.automatic &&
    !temporalNames &&
    !hasQuestion("_systemfield_name", "Full name") &&
    !("_systemfield_name" in frozenAnswers)
  const needsEmail =
    row.data.automatic &&
    !hasQuestion("_systemfield_email", "Email") &&
    !("_systemfield_email" in frozenAnswers)
  const identity: Record<string, string> = {}
  if (needsName || needsEmail) {
    // Native auto-apply reports only missing questions. This fixture checks its
    // unchanged generated identity against preparation's source checkpoint;
    // manual fixtures must still contain explicit answers.
    const source = await db
      .from("application_tasks")
      .select("output")
      .eq("application_id", fixture.application_id)
      .eq("stage", "load_source")
      .eq("state", "completed")
      .lte("revision", row.data.revision)
      .order("revision", { ascending: false })
      .limit(1)
      .maybeSingle()
    const name = source.data?.output?.profile?.fullName
    const email = source.data?.output?.email
    if (
      source.error ||
      (needsName && (typeof name !== "string" || !name.trim())) ||
      (needsEmail && (typeof email !== "string" || !email.trim()))
    )
      return new Response("Approved identity source unavailable", {
        status: 422,
      })
    if (needsName) identity._systemfield_name = name
    if (needsEmail) identity._systemfield_email = email
  }
  const form = await request.formData()
  if (
    row.data.employer_key === "synthetic-field-assistance" &&
    (form.get("location") !== answer("location", "Location") ||
      form.get("locationCode") !== "city-qa")
  )
    return new Response("Location selection was not committed", { status: 422 })
  for (const [key, id, label] of [
    [
      "name",
      "_systemfield_name",
      temporalNames ? "Preferred First & Last Name" : "Full name",
    ],
    ["email", "_systemfield_email", "Email"],
    [
      "authorization",
      "authorization",
      "Do you have the required work authorization?",
    ],
    ["referral", "referral", "Who is your employee referral contact?"],
    ...(temporalNames
      ? [
          ["legalGivenName", "legal-first-name", "Legal First Name"],
          ["legalFamilyName", "legal-last-name", "Legal Last Name"],
          ["linkedin", "linkedin", "LinkedIn Profile"],
        ]
      : []),
  ]) {
    if (form.get(key) !== (id in identity ? identity[id] : answer(id, label)))
      return new Response("Approved answer mismatch", { status: 422 })
  }
  if (
    temporalNames &&
    [
      ["pronouns", "Preferred Pronouns"],
      ["pronunciation", "Name Pronunciation"],
    ].some(([id, label]) => form.get(id) !== (answer(id, label) || ""))
  )
    return new Response("Unapproved optional identity answer", { status: 422 })
  const expectedConsent =
    (
      answer("consent", "Optional future contact") ||
      packet.answers["future-contact"]
    )?.includes("I agree") || false
  if (Boolean(form.get("futureContact")) !== expectedConsent)
    return new Response("Consent mismatch", { status: 422 })
  const resume = form.get("resume")
  if (!(resume instanceof File) || resume.size > 1000000)
    return new Response("Resume missing", { status: 422 })
  if (
    !(await testResumeMatches(
      new Uint8Array(await resume.arrayBuffer()),
      packet.resume
    ))
  )
    return new Response("Approved resume mismatch or invalid document", {
      status: 422,
    })
  const saved = await db
    .from("application_test_receipts")
    .update({ submissions: 1, received_at: new Date().toISOString() })
    .eq("token", token)
    .eq("submissions", 0)
    .select("token")
    .maybeSingle()
  if (saved.error || !saved.data)
    return new Response("Already received", { status: 409 })
  // Only an operator-created synthetic run can request this generated manual
  // step. It is deliberately not a CAPTCHA and never contacts an employer.
  if (row.data.employer_key === "synthetic-human-assistance")
    return testHtml(
      `<h1>Generated manual verification step</h1><p>This is a synthetic test, not a CAPTCHA.</p><iframe title="Generated verification" src="/application-test/${token}?challenge=1"></iframe><p><a href="/application-test/${token}">Complete synthetic verification</a></p>`,
      200,
      true
    )
  return testHtml(
    "<h1>Thank you for applying</h1><p>Your application has been received by the synthetic staging employer. No real employer was contacted and no email was sent.</p>"
  )
}
