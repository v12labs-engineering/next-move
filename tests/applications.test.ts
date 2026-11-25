import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"
import {
  applicationTarget,
  missingAnswers,
  suggestExperienceAnswers,
  applicationUnavailableReason,
  profileAnswers,
  fillMissingProfileAnswers,
  type ApplicationPacket,
} from "../lib/applications"
const alice = "00000000-0000-4000-8000-000000000001",
  bob = "00000000-0000-4000-8000-000000000002"
const packet: ApplicationPacket = {
  title: "Engineer",
  company: "Example",
  resume: "A truthful original resume with TypeScript and SQL experience.",
  fields: [
    {
      id: "email",
      label: "Email",
      help: "",
      kind: "email",
      required: true,
      options: [],
    },
    {
      id: "visa",
      label: "Work authorization",
      help: "",
      kind: "radio",
      required: true,
      options: ["Yes", "No"],
    },
    {
      id: "consent",
      label: "Optional consent",
      help: "",
      kind: "checkbox",
      required: false,
      options: ["I agree"],
    },
  ],
  answers: { email: "qa@example.test", visa: "No" },
  notices: "",
  formHash: "test",
  tailored: true,
}
test("experience suggestions preserve source wording and never infer salary, visas or motivation", () => {
  const question = {
    id: "experience",
    label: "Describe a relevant TypeScript API project you built",
    help: "",
    kind: "textarea" as const,
    required: true,
    options: [],
  }
  const source =
    "Built a TypeScript API and SQL persistence for a staging test project."
  assert.deepEqual(suggestExperienceAnswers([question], [{ text: source }]), {
    experience: source,
  })
  for (const label of [
    "Describe your visa authorization experience",
    "Why are you interested in this project?",
    "Describe your salary expectations",
    "How many years of TypeScript experience?",
  ])
    assert.deepEqual(
      suggestExperienceAnswers([{ ...question, label }], [{ text: source }]),
      {}
    )
})
test("canonical Ashby, Greenhouse and Lever URLs are eligible; unsafe hosts are rejected", () => {
  assert.equal(
    applicationTarget(
      "https://jobs.ashbyhq.com/n8n/1af7a193-334d-4d5c-b45d-250122d9c3f1?utm=x"
    ),
    "https://jobs.ashbyhq.com/n8n/1af7a193-334d-4d5c-b45d-250122d9c3f1/application"
  )
  for (const url of [
    "https://job-boards.greenhouse.io/deliveroo/jobs/8202442",
    "https://job-boards.greenhouse.io/deliveroo/jobs/8311914",
    "https://boards.greenhouse.io/example/jobs/1234",
    "https://job-boards.eu.greenhouse.io/example/jobs/1234",
  ]) {
    assert.equal(applicationTarget(`${url}?source=test`), url)
    assert.equal(applicationUnavailableReason({ url }), null)
  }
  assert.equal(
    applicationTarget(
      "https://jobs.lever.co/example/1af7a193-334d-4d5c-b45d-250122d9c3f1"
    ),
    "https://jobs.lever.co/example/1af7a193-334d-4d5c-b45d-250122d9c3f1/apply"
  )
  assert.equal(
    applicationUnavailableReason({ url: "https://example.com/jobs/1" }),
    null
  )
  assert.equal(
    applicationUnavailableReason({
      url: "https://job-boards.greenhouse.io/example/jobs/1",
      isActive: false,
    }),
    "This listing is closed."
  )
  for (const url of [
    "https://jobs.ashbyhq.com.evil.test/n8n/x",
    "http://jobs.ashbyhq.com/n8n/1af7a193-334d-4d5c-b45d-250122d9c3f1",
    "https://user:pass@jobs.ashbyhq.com/n8n/1af7a193-334d-4d5c-b45d-250122d9c3f1",
    "http://127.0.0.1",
    "file:///etc/passwd",
    "https://job-boards.greenhouse.io.evil.test/example/jobs/123",
    "https://jobs.lever.co:444/example/1af7a193-334d-4d5c-b45d-250122d9c3f1",
  ])
    assert.equal(applicationTarget(url), null)
})
test("identity autofill copies confirmed values and never answers personal/legal questions", () => {
  const fields = [
    "First Name",
    "Last Name",
    "Email",
    "Salary",
    "Work authorization",
    "Gender",
    "Consent",
    "LinkedIn Profile",
  ].map((label, i) => ({
    id: String(i),
    label,
    help: "",
    kind: "text" as const,
    required: true,
    options: [],
  }))
  assert.deepEqual(
    profileAnswers(
      fields,
      {
        fullName: "Test Candidate",
        resumeText: "Profile: https://www.linkedin.com/in/test-candidate",
      },
      "verified@example.test"
    ),
    {
      0: "Test",
      1: "Candidate",
      2: "verified@example.test",
      7: "https://www.linkedin.com/in/test-candidate",
    }
  )
})
test("identity names recognize full-name and separate-name wording without dropping name parts", () => {
  const labels = [
    "Your full name",
    "Please enter your full name",
    "First and last name",
    "First name(s)",
    "Given name(s)",
    "First Name / Given Name",
    "Last name (Surname)",
    "Family name",
  ]
  const fields = labels.map((label, i) => ({
    id: String(i),
    label,
    help: "",
    kind: "text" as const,
    required: true,
    options: [],
  }))
  assert.deepEqual(
    profileAnswers(
      fields,
      {
        fullName: "Alex Rivera",
        resumeText: "",
      },
      "qa@example.test"
    ),
    {
      0: "Alex Rivera",
      1: "Alex Rivera",
      2: "Alex Rivera",
      3: "Alex",
      4: "Alex",
      5: "Alex",
      6: "Rivera",
      7: "Rivera",
    }
  )
})
test("compound names use confirmed components instead of guessing the split", () => {
  const fields = ["Full name", "First name", "Last name"].map((label, i) => ({
    id: String(i),
    label,
    help: "",
    kind: "text" as const,
    required: true,
    options: [],
  }))
  const identity = { fullName: "Alex Morgan Rivera", resumeText: "" }
  assert.deepEqual(profileAnswers(fields, identity, "qa@example.test"), {
    0: "Alex Morgan Rivera",
  })
  assert.deepEqual(
    profileAnswers(
      fields,
      {
        ...identity,
        givenName: "Alex Morgan",
        familyName: "Rivera",
      },
      "qa@example.test"
    ),
    {
      0: "Alex Morgan Rivera",
      1: "Alex Morgan",
      2: "Rivera",
    }
  )
})
test("name autocomplete cannot override a different question or contradictory name label", () => {
  const fields = [
    { label: "Salary expectation", autocomplete: "given-name" },
    { label: "Company name", autocomplete: "name" },
    { label: "First name", autocomplete: "family-name" },
    { label: "Name", autocomplete: "name", help: "Name of your referee" },
    { label: "Preferred name", autocomplete: "given-name" },
  ].map((field, i) => ({
    help: "",
    ...field,
    id: String(i),
    kind: "text" as const,
    required: true,
    options: [],
  }))
  assert.deepEqual(
    profileAnswers(
      fields,
      { fullName: "Alex Rivera", resumeText: "" },
      "qa@example.test"
    ),
    {}
  )
})
test("autofill uses resume contact details with common labels and bare LinkedIn URLs", () => {
  const fields = [
    { id: "email", label: "Email address (required)", kind: "email" as const },
    { id: "phone", label: "Phone number", kind: "tel" as const },
    { id: "linkedin", label: "LinkedIn URL (optional)", kind: "url" as const },
  ].map((field) => ({ ...field, help: "", required: true, options: [] }))
  const answers = profileAnswers(
    fields,
    {
      fullName: "Test Candidate",
      resumeText:
        "Test Candidate\nEmail: candidate@example.test\nPhone: +91 98765 43210\nLinkedIn: www.linkedin.com/in/test-candidate",
    },
    "login@example.test"
  )
  assert.deepEqual(answers, {
    email: "candidate@example.test",
    phone: "+91 98765 43210",
    linkedin: "https://www.linkedin.com/in/test-candidate",
  })
  assert.deepEqual(missingAnswers({ ...packet, fields, answers }), [])
})
test("contact autofill supports autocomplete, name-only fields and source URL punctuation", () => {
  const fields = [
    { id: "phone", label: "phone_number", kind: "text" as const },
    {
      id: "email",
      label: "Contact",
      autocomplete: "section-application email",
      kind: "text" as const,
    },
    { id: "linkedin", label: "linkedin_url", kind: "url" as const },
    { id: "github", label: "GitHub profile", kind: "text" as const },
  ].map((field) => ({ ...field, help: "", required: true, options: [] }))
  assert.deepEqual(
    profileAnswers(
      fields,
      {
        fullName: "Test Candidate",
        resumeText:
          "Email: candidate@example.test\nMobile: +1 (415) 555-2671\nProfiles: (http://www.linkedin.com/in/test-candidate), github.com/test-candidate.",
      },
      "login@example.test"
    ),
    {
      email: "candidate@example.test",
      phone: "+1 (415) 555-2671",
      linkedin: "http://www.linkedin.com/in/test-candidate",
      github: "https://github.com/test-candidate",
    }
  )
})
test("ambiguous and absent contacts stay blank; email can fall back to the verified account", () => {
  const fields = [
    { id: "phone", label: "Phone number", kind: "tel" as const },
    { id: "email", label: "Email", kind: "email" as const },
    { id: "linkedin", label: "LinkedIn URL", kind: "url" as const },
  ].map((field) => ({ ...field, help: "", required: true, options: [] }))
  for (const resumeText of [
    "2018 - 2024\nProcessed 1234567890 records. No contact details provided.",
    "Phone: +1 415 555 2671\nPhone: +1 212 555 1234\nfirst@example.test second@example.test\nlinkedin.com/in/first linkedin.com/in/second",
    "References: phone +1 415 555 2671\nhttps://evil.test/linkedin.com/in/candidate\nhttps://linkedin.com.evil.test/in/candidate",
  ])
    assert.deepEqual(
      profileAnswers(
        fields,
        { fullName: "Test Candidate", resumeText },
        "verified@example.test"
      ),
      { email: "verified@example.test" }
    )
})
test("candidate contact details never answer reference, consent or motivation questions", () => {
  const fields = [
    { id: "reference", label: "Reference email", kind: "email" as const },
    { id: "emergency", label: "Emergency contact phone", kind: "tel" as const },
    {
      id: "why",
      label: "Why does your LinkedIn experience suit this role?",
      kind: "text" as const,
    },
    {
      id: "consent",
      label: "Consent to contact by phone",
      kind: "text" as const,
    },
    { id: "country", label: "Phone country code", kind: "tel" as const },
    { id: "extension", label: "Extension", kind: "tel" as const },
  ].map((field) => ({ ...field, help: "", required: true, options: [] }))
  assert.deepEqual(
    profileAnswers(
      fields,
      {
        fullName: "Test Candidate",
        resumeText:
          "candidate@example.test | +91 98765 43210 | linkedin.com/in/test-candidate",
      },
      "login@example.test"
    ),
    {}
  )
})
test("refilling a paused packet preserves candidate edits and fills only blank contact answers", () => {
  const fields = [
    { id: "email", label: "Email", kind: "email" as const },
    { id: "phone", label: "Phone number", kind: "tel" as const },
    { id: "linkedin", label: "LinkedIn URL", kind: "url" as const },
    { id: "salary", label: "Salary", kind: "text" as const },
  ].map((field) => ({ ...field, help: "", required: true, options: [] }))
  const original = {
    ...packet,
    fields,
    answers: { email: "edited@example.test", phone: "  ", salary: "100000" },
  }
  const updated = fillMissingProfileAnswers(
    original,
    {
      fullName: "Test Candidate",
      resumeText:
        "candidate@example.test | +91 98765 43210 | linkedin.com/in/test-candidate",
    },
    "login@example.test"
  )
  assert.deepEqual(updated.answers, {
    email: "edited@example.test",
    phone: "+91 98765 43210",
    linkedin: "https://linkedin.com/in/test-candidate",
    salary: "100000",
  })
  assert.deepEqual(original.answers, {
    email: "edited@example.test",
    phone: "  ",
    salary: "100000",
  })
  assert.equal(updated.resume, original.resume)
})
test("required factual answers and unsupported controls prevent submission; optional consent stays blank", () => {
  assert.deepEqual(missingAnswers(packet), [])
  assert.deepEqual(
    missingAnswers({ ...packet, answers: { email: "bad", visa: "maybe" } }),
    ["Email", "Work authorization"]
  )
  assert.deepEqual(
    missingAnswers({
      ...packet,
      fields: [
        ...packet.fields,
        {
          id: "custom",
          label: "Address picker",
          help: "",
          required: true,
          kind: "unsupported",
          options: [],
        },
      ],
    }),
    ["Address picker"]
  )
  assert.deepEqual(
    missingAnswers({
      ...packet,
      answers: { ...packet.answers, hidden: "injected" },
    }),
    ["Unknown question"]
  )
})
test("real Postgres enforces approval, isolation, edits, cancellation and one confirmed send", async () => {
  const db = new PGlite()
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth,public to anon,authenticated,service_role;insert into auth.users values('${alice}'),('${bob}');
 create table public.job_catalog(id text primary key,title text,company text,country text,url text,is_active boolean default true,last_checked_at timestamptz default now());
 create table public.account_profiles(user_id uuid primary key);
 create table public.account_ai_usage(user_id uuid,day date,attempts integer,primary key(user_id,day));
 create table public.account_job_states(user_id uuid,job_id text,status text,updated_at timestamptz default now(),primary key(user_id,job_id));
 create function public.reserve_tailoring_attempt() returns boolean language sql as $$ select true $$;
 insert into public.account_profiles values('${alice}'),('${bob}');
 insert into public.job_catalog(id,title,company,url) values('job-1','Engineer','Example','https://jobs.ashbyhq.com/example/1af7a193-334d-4d5c-b45d-250122d9c3f1');`)
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/202610290004_application_runner.sql",
          import.meta.url
        ),
        "utf8"
      )
    )
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/202610290005_application_claim.sql",
          import.meta.url
        ),
        "utf8"
      )
    )
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/202610300001_automatic_applications.sql",
          import.meta.url
        ),
        "utf8"
      )
    )
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/202610300002_site_independent_applications.sql",
          import.meta.url
        ),
        "utf8"
      )
    )
    const asUser = async (id: string) => {
      await db.exec("reset role")
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
        id,
      ])
      await db.exec("set role authenticated")
    }
    await db.exec("set role anon")
    await assert.rejects(
      db.exec("select * from application_runs"),
      /permission denied/
    )
    await assert.rejects(
      db.exec("select create_application('job-1')"),
      /permission denied/
    )
    await asUser(alice)
    const id = (
      await db.query<{ id: string }>("select create_application('job-1') id")
    ).rows[0].id
    assert.equal(
      (await db.query<{ id: string }>("select create_application('job-1') id"))
        .rows[0].id,
      id
    )
    await assert.rejects(
      db.query("update application_runs set status='submitted' where id=$1", [
        id,
      ]),
      /permission denied/
    )
    await db.exec("reset role")
    await db.query(
      "update application_runs set status='ready',packet=$2::jsonb where id=$1",
      [id, JSON.stringify(packet)]
    )
    await asUser(bob)
    assert.equal(
      (await db.exec("select * from application_runs"))[0].rows.length,
      0
    )
    assert.equal(
      (
        await db.query<{ ok: boolean }>("select approve_application($1,1) ok", [
          id,
        ])
      ).rows[0].ok,
      false
    )
    await assert.rejects(
      db.query("select edit_application($1,1,$2::jsonb,$3)", [
        id,
        JSON.stringify(packet.answers),
        packet.resume,
      ]),
      /changed/
    )
    assert.equal(
      (await db.exec("select * from application_events"))[0].rows.length,
      0
    )
    await asUser(alice)
    assert.equal(
      (
        await db.query<{ ok: boolean }>("select approve_application($1,1) ok", [
          id,
        ])
      ).rows[0].ok,
      true
    )
    assert.equal(
      (
        await db.query<{ ok: boolean }>("select approve_application($1,1) ok", [
          id,
        ])
      ).rows[0].ok,
      false
    )
    await db.query("select edit_application($1,1,$2::jsonb,$3)", [
      id,
      JSON.stringify({ ...packet.answers, visa: "Yes" }),
      packet.resume,
    ])
    const edited = (
      await db.query<{
        revision: number
        approved_revision: number | null
        status: string
      }>(
        "select revision,approved_revision,status from application_runs where id=$1",
        [id]
      )
    ).rows[0]
    assert.deepEqual(edited, {
      revision: 2,
      approved_revision: null,
      status: "ready",
    })
    assert.equal(
      (
        await db.query<{ ok: boolean }>("select approve_application($1,1) ok", [
          id,
        ])
      ).rows[0].ok,
      false
    )
    await db.query("select approve_application($1,2)", [id])
    await db.exec("reset role;set role service_role")
    assert.equal(
      (
        await db.query<{ ok: boolean }>(
          "select confirm_application($1,2,$2::jsonb) ok",
          [id, JSON.stringify({ text: "Thank you for applying" })]
        )
      ).rows[0].ok,
      false
    )
    const claim = "select id from claim_application($1,$2)"
    assert.equal((await db.query(claim, [id, 1])).rows.length, 0)
    assert.equal((await db.query(claim, [id, 2])).rows.length, 1)
    assert.equal((await db.query(claim, [id, 2])).rows.length, 0)
    await asUser(alice)
    assert.equal(
      (
        await db.query<{ ok: boolean }>("select cancel_application($1,2) ok", [
          id,
        ])
      ).rows[0].ok,
      false
    )
    await assert.rejects(
      db.query("select edit_application($1,2,$2::jsonb,$3)", [
        id,
        JSON.stringify(packet.answers),
        packet.resume,
      ]),
      /changed/
    )
    await db.exec("reset role;set role service_role")
    await db.query(
      "update application_runs set status='submitting' where id=$1",
      [id]
    )
    assert.equal(
      (
        await db.query<{ ok: boolean }>(
          "select confirm_application($1,2,$2::jsonb) ok",
          [id, JSON.stringify({ text: "Thank you for applying" })]
        )
      ).rows[0].ok,
      true
    )
    assert.equal(
      (
        await db.query<{ ok: boolean }>(
          "select confirm_application($1,2,$2::jsonb) ok",
          [id, JSON.stringify({ text: "Thank you for applying" })]
        )
      ).rows[0].ok,
      false
    )
    await db.exec("reset role")
    assert.equal(
      (
        await db.query<{ status: string }>(
          "select status from account_job_states where user_id=$1",
          [alice]
        )
      ).rows[0].status,
      "applied"
    )
    await asUser(alice)
    assert.equal(
      (
        await db.query<{ ok: boolean }>(
          "select retry_application_preparation($1) ok",
          [id]
        )
      ).rows[0].ok,
      false
    )
    await assert.rejects(
      db.query("select claim_application($1,2)", [id]),
      /permission denied/
    )
    await db.exec("reset role;set role service_role")
    const n8nIds = [
      "00000000-0000-4000-8000-000000000011",
      "00000000-0000-4000-8000-000000000012",
    ]
    for (const [i, runId] of n8nIds.entries())
      await db.query(
        "insert into application_runs(id,user_id,target_url,status,packet,approved_packet,approved_revision,approved_at) values($1,$2,$3,'queued',$4::jsonb,$4::jsonb,1,now())",
        [
          runId,
          alice,
          `https://jobs.ashbyhq.com/n8n/00000000-0000-4000-8000-00000000001${i}/application`,
          JSON.stringify(packet),
        ]
      )
    assert.equal(
      (await db.query("select id from claim_application($1,1)", [n8nIds[0]]))
        .rows.length,
      1
    )
    assert.equal(
      (await db.query("select id from claim_application($1,1)", [n8nIds[1]]))
        .rows.length,
      0
    )
    await db.query(
      "update application_runs set status='submission_unknown' where id=$1",
      [n8nIds[0]]
    )
    await asUser(alice)
    assert.equal(
      (
        await db.query<{ ok: boolean }>(
          "select retry_application_preparation($1) ok",
          [n8nIds[0]]
        )
      ).rows[0].ok,
      false
    )
    await assert.rejects(
      db.query("select edit_application($1,1,$2::jsonb,$3)", [
        n8nIds[0],
        JSON.stringify(packet.answers),
        packet.resume,
      ]),
      /changed/
    )
    assert.equal(
      (
        await db.query<{ ok: boolean }>("select cancel_application($1,1) ok", [
          n8nIds[1],
        ])
      ).rows[0].ok,
      true
    )
    await db.exec("reset role")
    await db.query(
      "insert into job_catalog(id,title,company,url) values('greenhouse','Engineer','Example',$1)",
      ["https://job-boards.greenhouse.io/deliveroo/jobs/8202442?source=example"]
    )
    for (const url of [
      "https://job-boards.greenhouse.io/deliveroo/jobs/8202442?x=1",
      "https://jobs.lever.co/example/1af7a193-334d-4d5c-b45d-250122d9c3f1",
      "https://jobs.ashbyhq.com/example/1af7a193-334d-4d5c-b45d-250122d9c3f1",
      "https://evil.test/example/jobs/1",
      "https://careers.example.com/apply?jobId=1#application",
      "https://CAREERS.example.com",
      "https://careers.example.com:443?jobId=1",
      "https://metadata.google.internal/latest",
      "https://careers.example.com/jobs/1",
    ]) {
      assert.equal(
        (
          await db.query<{ target: string | null }>(
            "select application_target($1) target",
            [url]
          )
        ).rows[0].target,
        applicationTarget(url)
      )
    }
    await asUser(alice)
    const autoId = (
      await db.query<{ id: string }>(
        "select request_automatic_application('greenhouse') id"
      )
    ).rows[0].id
    assert.equal(
      (
        await db.query<{ id: string }>(
          "select request_automatic_application('greenhouse') id"
        )
      ).rows[0].id,
      autoId
    )
    await assert.rejects(
      db.query("select queue_automatic_application($1,1)", [autoId]),
      /permission denied/
    )
    await db.exec("reset role;set role service_role")
    await db.query(
      "update application_runs set status='ready',packet=$2::jsonb,auto_submit_requested_at=now()-interval '31 minutes' where id=$1",
      [autoId, JSON.stringify(packet)]
    )
    assert.equal(
      (
        await db.query<{ ok: boolean }>(
          "select queue_automatic_application($1,1) ok",
          [autoId]
        )
      ).rows[0].ok,
      false
    )
    await asUser(alice)
    await db.query("select request_automatic_application('greenhouse')")
    await asUser(bob)
    await assert.rejects(
      db.query("select continue_application($1,1,$2::jsonb,$3)", [
        autoId,
        JSON.stringify(packet.answers),
        packet.resume,
      ]),
      /changed/
    )
    await asUser(alice)
    // An edit revokes the initial automatic request. A stale worker cannot send.
    await db.query("select edit_application($1,1,$2::jsonb,$3)", [
      autoId,
      JSON.stringify(packet.answers),
      packet.resume,
    ])
    await db.exec("reset role;set role service_role")
    assert.equal(
      (
        await db.query<{ ok: boolean }>(
          "select queue_automatic_application($1,2) ok",
          [autoId]
        )
      ).rows[0].ok,
      false
    )
    await asUser(alice)
    await db.query("select request_automatic_application('greenhouse')")
    await db.exec("reset role;set role service_role")
    assert.equal(
      (
        await db.query<{ ok: boolean }>(
          "select queue_automatic_application($1,2) ok",
          [autoId]
        )
      ).rows[0].ok,
      true
    )
    assert.equal(
      (
        await db.query<{ ok: boolean }>(
          "select queue_automatic_application($1,2) ok",
          [autoId]
        )
      ).rows[0].ok,
      false
    )
    assert.equal(
      (await db.query("select id from claim_application($1,2)", [autoId])).rows
        .length,
      1
    )
    // An unrelated employer with the same /careers URL segment can run at the
    // same time. A repeated click after a catalogue URL change reuses its run.
    await db.exec("reset role")
    await db.query(
      "insert into job_catalog(id,title,company,url) values('generic','Engineer','Different Employer',$1)",
      ["https://careers.example.com/careers/123?jobId=1"]
    )
    await asUser(alice)
    const genericId = (
      await db.query<{ id: string }>(
        "select request_automatic_application('generic') id"
      )
    ).rows[0].id
    await assert.rejects(
      db.query("select reserve_application_decision($1)", [genericId]),
      /permission denied/
    )
    await db.exec("reset role")
    await db.query(
      "update job_catalog set url='https://new-careers.example.org/careers/123?jobId=1' where id='generic'"
    )
    await asUser(alice)
    assert.equal(
      (
        await db.query<{ id: string }>(
          "select request_automatic_application('generic') id"
        )
      ).rows[0].id,
      genericId
    )
    await db.exec("reset role;set role service_role")
    await db.query(
      "update application_runs set status='ready',packet=$2::jsonb where id=$1",
      [genericId, JSON.stringify(packet)]
    )
    assert.equal(
      (
        await db.query<{ ok: boolean }>(
          "select queue_automatic_application($1,1) ok",
          [genericId]
        )
      ).rows[0].ok,
      true
    )
    assert.equal(
      (await db.query("select id from claim_application($1,1)", [genericId]))
        .rows.length,
      1
    )
    for (let n = 0; n < 6; n++)
      assert.equal(
        (
          await db.query<{ ok: boolean }>(
            "select reserve_application_decision($1) ok",
            [genericId]
          )
        ).rows[0].ok,
        true
      )
    assert.equal(
      (
        await db.query<{ ok: boolean }>(
          "select reserve_application_decision($1) ok",
          [genericId]
        )
      ).rows[0].ok,
      false
    )
    await db.query(
      "update application_runs set status='ready',revision=2,approved_packet=null,approved_revision=null,approved_at=null where id=$1",
      [genericId]
    )
    assert.equal(
      (
        await db.query<{ attempts: number }>(
          "select decision_attempts attempts from application_runs where id=$1",
          [genericId]
        )
      ).rows[0].attempts,
      0
    )
    await asUser(alice)
    await db.query("select continue_application($1,2,$2::jsonb,$3)", [
      genericId,
      JSON.stringify(packet.answers),
      packet.resume,
    ])
    await db.exec("reset role;set role service_role")
    assert.equal(
      (await db.query("select id from claim_application($1,3)", [genericId]))
        .rows.length,
      1
    )
    await db.exec("reset role")
    await db.query("update account_ai_usage set attempts=10 where user_id=$1", [
      alice,
    ])
    await db.exec("set role service_role")
    assert.equal(
      (
        await db.query<{ ok: boolean }>(
          "select reserve_application_decision($1) ok",
          [autoId]
        )
      ).rows[0].ok,
      false
    )
    assert.equal(
      (
        await db.query<{ attempts: number }>(
          "select decision_attempts attempts from application_runs where id=$1",
          [autoId]
        )
      ).rows[0].attempts,
      0
    )
    // An employer changing hosts must still share its send limit.
    const alternate = "00000000-0000-4000-8000-000000000031"
    await db.query(
      "insert into application_runs(id,user_id,target_url,employer_key,status,packet,approved_packet,approved_revision,approved_at) values($1,$2,$3,'example','queued',$4::jsonb,$4::jsonb,1,now())",
      [
        alternate,
        alice,
        "https://hiring.example.org/careers/other-role",
        JSON.stringify(packet),
      ]
    )
    assert.equal(
      (await db.query("select id from claim_application($1,1)", [alternate]))
        .rows.length,
      0
    )
    await db.query(
      "update application_runs set status='submission_unknown' where id=$1",
      [genericId]
    )
    await asUser(alice)
    assert.equal(
      (
        await db.query<{ id: string }>(
          "select request_automatic_application('generic') id"
        )
      ).rows[0].id,
      genericId
    )
    assert.equal(
      (
        await db.query<{ status: string }>(
          "select status from application_runs where id=$1",
          [genericId]
        )
      ).rows[0].status,
      "submission_unknown"
    )
    await db.exec("reset role;set role service_role")
    // A subsequent form page needs an answer: pause in-app and clear approval.
    await db.query(
      "update application_runs set status='ready',revision=3,approved_packet=null,approved_revision=null,approved_at=null where id=$1",
      [autoId]
    )
    await asUser(alice)
    assert.equal(
      (
        await db.query<{ revision: number }>(
          "select continue_application($1,3,$2::jsonb,$3) revision",
          [autoId, JSON.stringify(packet.answers), packet.resume]
        )
      ).rows[0].revision,
      4
    )
    await assert.rejects(
      db.query("select continue_application($1,3,$2::jsonb,$3)", [
        autoId,
        JSON.stringify(packet.answers),
        packet.resume,
      ]),
      /changed/
    )
    await db.exec("reset role;set role service_role")
    assert.equal(
      (await db.query("select id from claim_application($1,4)", [autoId])).rows
        .length,
      1
    )
    assert.equal(
      (await db.query("select id from claim_application($1,4)", [autoId])).rows
        .length,
      0
    )
    await db.query(
      "update application_runs set status='submitting' where id=$1",
      [autoId]
    )
    assert.equal(
      (
        await db.query<{ ok: boolean }>(
          "select confirm_application($1,4,$2::jsonb) ok",
          [autoId, JSON.stringify({ text: "Synthetic employer confirmed" })]
        )
      ).rows[0].ok,
      true
    )
    await asUser(alice)
    await db.query("select request_automatic_application('greenhouse')")
    const final = (
      await db.query<{ status: string; auto_submit_requested_at: null }>(
        "select status,auto_submit_requested_at from application_runs where id=$1",
        [autoId]
      )
    ).rows[0]
    assert.equal(final.status, "submitted")
    assert.equal(final.auto_submit_requested_at, null)
  } finally {
    await db.close()
  }
})
