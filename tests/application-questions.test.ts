import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"
import {
  applyRememberedAnswers,
  sameSavedQuestion,
  type SavedQuestion,
} from "../lib/applications/questions"
import type { ApplicationPacket } from "../lib/applications"

const alice = "00000000-0000-4000-8000-000000000001",
  bob = "00000000-0000-4000-8000-000000000002"
const ids = [1, 2, 3, 4, 5].map(
  (n) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`
)
const packet: ApplicationPacket = {
  title: "Engineer",
  company: "Example",
  resume: "A fictional QA resume with TypeScript and SQL experience.",
  notices: "",
  formHash: "fixture",
  tailored: true,
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
      label: "Do you require sponsorship?",
      help: "For this destination",
      kind: "radio",
      required: true,
      options: ["Yes", "No"],
    },
    {
      id: "consent",
      label: "Optional future contact",
      help: "",
      kind: "checkbox",
      required: false,
      options: ["I agree"],
    },
    {
      id: "resume",
      label: "Resume",
      help: "",
      kind: "resume",
      required: true,
      options: [],
    },
  ],
  answers: { email: "fictional@example.test" },
}
const memory = (overrides: Partial<SavedQuestion> = {}): SavedQuestion => ({
  id: ids[0],
  question: packet.fields[1],
  answer: "No",
  reuse_scope: "all",
  company: "Example",
  country: "Germany",
  source_application_id: ids[1],
  last_seen_at: new Date().toISOString(),
  ...overrides,
})

test("saved answers use exact question meaning, preserve explicit edits and never use unsupported or unapproved defaults", () => {
  const result = applyRememberedAnswers(packet, [memory()])
  assert.equal(result.answers.visa, "No")
  assert.equal(result.rememberedAnswers?.visa.id, ids[0])
  for (const field of [
    { ...packet.fields[1], label: "Do you NOT require sponsorship?" },
    { ...packet.fields[1], help: "For a different destination" },
    { ...packet.fields[1], options: ["Yes", "No", "Unsure"] },
    { ...packet.fields[1], kind: "text" as const },
  ])
    assert.equal(
      applyRememberedAnswers({ ...packet, fields: [field], answers: {} }, [
        memory(),
      ]).answers.visa,
      undefined
    )
  assert.equal(
    sameSavedQuestion(packet.fields[1], {
      ...packet.fields[1],
      id: "new-id",
      required: false,
      label: "  DO YOU require sponsorship?  ",
    }),
    true
  )
  for (const value of ["Yes", "", []])
    assert.deepEqual(
      applyRememberedAnswers({ ...packet, answers: { visa: value } }, [
        memory(),
      ]).answers.visa,
      value
    )
  for (const row of [
    memory({ reuse_scope: "never" }),
    memory({ answer: null }),
    memory({ answer: "Invented choice" }),
    memory({ question: { ...packet.fields[1], kind: "unsupported" } }),
  ])
    assert.equal(applyRememberedAnswers(packet, [row]).answers.visa, undefined)
  const changed = applyRememberedAnswers(
    { ...result, answers: { ...result.answers, visa: "Yes" } },
    [memory()]
  )
  assert.equal(changed.rememberedAnswers?.visa, undefined)
  assert.equal(
    applyRememberedAnswers(packet, [
      memory({ question: packet.fields[2], answer: ["I agree"] }),
    ]).answers.consent,
    undefined
  )
})

test("Postgres remembers new questions, isolates users and destinations, saves reuse atomically, and derives persistent alerts", async () => {
  const db = new PGlite()
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth,public to anon,authenticated,service_role;
   insert into auth.users values('${alice}'),('${bob}');create table public.job_catalog(id text primary key,title text,company text,country text,url text,is_active boolean default true,last_checked_at timestamptz default now());create table public.account_profiles(user_id uuid primary key);insert into public.account_profiles values('${alice}'),('${bob}');create table public.account_ai_usage(user_id uuid,day date,attempts integer,primary key(user_id,day));create table public.account_job_states(user_id uuid,job_id text,status text,updated_at timestamptz default now(),primary key(user_id,job_id));create function public.reserve_tailoring_attempt() returns boolean language sql as $$select true$$;
   insert into public.job_catalog(id,title,company,country,url) values('de','Engineer','Example','Germany','https://example.test/1'),('other','Engineer','Other','Germany','https://other.test/1'),('ca','Engineer','Example','Canada','https://example.test/2'),('de-next','Engineer','Example','Germany','https://example.test/3');`)
    for (const name of [
      "202610290004_application_runner.sql",
      "202610290005_application_claim.sql",
      "202610300001_automatic_applications.sql",
      "202610300002_site_independent_applications.sql",
    ])
      await db.exec(
        await readFile(
          new URL(`../supabase/migrations/${name}`, import.meta.url),
          "utf8"
        )
      )
    const seed = async (
      id: string,
      user: string,
      job: string,
      company: string
    ) =>
      db.query(
        `insert into application_runs(id,user_id,job_id,target_url,status,packet,employer_key) values($1,$2,$3,$4,'ready',$5::jsonb,lower($6))`,
        [
          id,
          user,
          job,
          `https://example.test/${id}`,
          JSON.stringify({ ...packet, company }),
          company,
        ]
      )
    // Existing unanswered packets must backfill without changing their revision.
    await seed(ids[0], alice, "de", "Example")
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/202610310003_application_question_memory.sql",
          import.meta.url
        ),
        "utf8"
      )
    )
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/202610310004_application_question_preferences.sql",
          import.meta.url
        ),
        "utf8"
      )
    )
    await seed(ids[1], alice, "other", "Other")
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/202611010032_application_profile_reuse_overrides.sql",
          import.meta.url
        ),
        "utf8"
      )
    )
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/202611040048_application_answer_reuse_defaults.sql",
          import.meta.url
        ),
        "utf8"
      )
    )
    await seed(ids[2], alice, "ca", "Example")
    await seed(ids[3], bob, "de", "Example")
    await seed(ids[4], alice, "de-next", "Example")
    const user = async (id: string) => {
      await db.exec("reset role")
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
        id,
      ])
      await db.exec("set role authenticated")
    }
    const alerts = async () =>
      (
        await db.query<{
          value: { applicationId: string; questions: unknown[] }[]
        }>("select application_question_alerts() value")
      ).rows[0].value
    await user(alice)
    let rows = (
      await db.query<SavedQuestion>(
        "select * from account_application_questions"
      )
    ).rows
    assert.equal(rows.length, 6)
    assert.ok(rows.every((r) => r.answer === null && r.reuse_scope === "never"))
    assert.ok(
      rows.every(
        (r) => r.question.id !== "email" && r.question.kind !== "resume"
      )
    )
    assert.equal((await alerts()).length, 4)
    assert.ok((await alerts()).every((a) => a.questions.length === 1))
    const no = { ...packet.answers, visa: "No" }
    const save = async (
      id: string,
      revision: number,
      answers: unknown,
      remember: unknown = {},
      cont = false
    ) =>
      db.query<{ v: number }>(
        "select save_application_review($1,$2,$3::jsonb,$4,$5::jsonb,$6) v",
        [
          id,
          revision,
          JSON.stringify(answers),
          packet.resume,
          JSON.stringify(remember),
          cont,
        ]
      )
    assert.equal((await save(ids[0], 1, no, { visa: "employer" })).rows[0].v, 2)
    assert.equal(
      (await alerts()).some((a) => a.applicationId === ids[0]),
      false
    )
    await assert.rejects(
      save(ids[0], 1, { ...no, visa: "Yes" }, { visa: "all" }),
      /changed/
    )
    await assert.rejects(
      save(ids[4], 1, { ...no, visa: "Invented" }, { visa: "all" }),
      /Invalid saved answer/
    )
    await assert.rejects(
      save(ids[4], 1, no, { "invented-field": "all" }),
      /Invalid saved answer/
    )
    await assert.rejects(
      save(ids[4], 1, { ...no, consent: ["I agree"] }, { consent: "all" }),
      /consent/
    )
    rows = (
      await db.query<SavedQuestion>(
        "select * from account_application_questions where answer is not null"
      )
    ).rows
    assert.equal(rows.length, 1)
    assert.equal(rows[0].answer, "No")
    assert.equal(rows[0].reuse_scope, "employer")
    const questionId = rows[0].id
    await assert.rejects(
      db.exec("update account_application_questions set reuse_scope='all'"),
      /permission denied/
    )
    await assert.rejects(
      db.query("select * from read_application_question_memory($1,$2::jsonb)", [
        ids[4],
        JSON.stringify(packet.fields),
      ]),
      /permission denied/
    )
    await user(bob)
    assert.equal((await alerts()).length, 1)
    assert.equal(
      (
        await db.query(
          "select * from account_application_questions where id=$1",
          [questionId]
        )
      ).rows.length,
      0
    )
    await assert.rejects(save(ids[0], 2, no, { visa: "all" }), /changed/)
    assert.equal(
      (
        await db.query<{ v: boolean }>(
          "select update_application_question($1,'\"Yes\"'::jsonb,'all') v",
          [questionId]
        )
      ).rows[0].v,
      false
    )
    assert.equal(
      (
        await db.query(
          "delete from account_application_questions where id=$1 returning id",
          [questionId]
        )
      ).rows.length,
      0
    )
    await db.exec("reset role;set role service_role")
    const read = async (id: string, fields = packet.fields) =>
      (
        await db.query<SavedQuestion>(
          "select * from read_application_question_memory($1,$2::jsonb)",
          [id, JSON.stringify(fields)]
        )
      ).rows
    assert.equal((await read(ids[4])).length, 1)
    assert.equal((await read(ids[1])).length, 0)
    assert.equal((await read(ids[2])).length, 0)
    assert.equal((await read(ids[3])).length, 0)
    assert.equal(
      (
        await read(ids[4], [
          { ...packet.fields[1], label: "Do you NOT require sponsorship?" },
        ])
      ).length,
      0
    )
    await user(alice)
    await db.query(
      "select update_application_question($1,'\"No\"'::jsonb,'all')",
      [questionId]
    )
    // Answers are remembered even when the candidate asks again next time.
    await save(ids[1], 1, { ...no, visa: "Yes" }, { visa: "never" })
    assert.equal(
      (
        await db.query<{ reuse_scope: string }>(
          "select reuse_scope from account_application_questions where employer_key='other' and answer is not null"
        )
      ).rows[0].reuse_scope,
      "never"
    )
    await db.query(
      "select update_application_question(id,'\"Yes\"'::jsonb,'employer') from account_application_questions where employer_key='other' and answer is not null"
    )
    await db.exec("reset role;set role service_role")
    const employerRows = await read(ids[1])
    assert.equal(employerRows.length, 2)
    assert.equal(
      applyRememberedAnswers({ ...packet, answers: {} }, employerRows).answers
        .visa,
      "Yes"
    )
    assert.equal((await read(ids[2])).length, 0)
    await user(alice)
    await db.query(
      "select update_application_question(id,'\"Yes\"'::jsonb,'all') from account_application_questions where employer_key='other' and answer is not null"
    )
    assert.equal(
      (
        await db.query<{ n: number }>(
          "select count(*)::int n from account_application_questions where reuse_scope='all'"
        )
      ).rows[0].n,
      1
    )
    await db.query(
      "select update_application_question($1,'\"No\"'::jsonb,'never')",
      [questionId]
    )
    await db.exec("reset role;set role service_role")
    const blockedRows = await read(ids[4])
    assert.equal(
      blockedRows.length,
      1,
      "Workers receive the explicit employer override instead of the global answer"
    )
    assert.equal(blockedRows[0].reuse_scope, "never")
    const blockedPacket = applyRememberedAnswers(
      { ...packet, answers: {} },
      blockedRows
    )
    assert.equal(blockedPacket.answers.visa, undefined)
    assert.deepEqual(blockedPacket.answerReuseBlocked, ["visa"])
    assert.equal((await read(ids[1])).length, 1)
    await user(alice)
    await db.exec("reset role")
    await db.query("update application_runs set packet=$1::jsonb where id=$2", [
      JSON.stringify({
        ...packet,
        answers: no,
        fields: [
          ...packet.fields,
          {
            id: "salary",
            label: "Salary expectation",
            help: "Annual EUR",
            kind: "number",
            required: true,
            options: [],
          },
        ],
      }),
      ids[4],
    ])
    assert.equal(
      (
        await db.query<{ n: number }>(
          "select count(*)::int n from account_application_questions where question->>'id'='salary'"
        )
      ).rows[0].n,
      1
    )
    await user(alice)
    assert.equal(
      (await alerts()).find((a) => a.applicationId === ids[4])?.questions
        .length,
      1
    )
    await db.query("select cancel_application($1,1)", [ids[4]])
    assert.equal(
      (await alerts()).some((a) => a.applicationId === ids[4]),
      false
    )
    await db.query("delete from account_application_questions where id=$1", [
      questionId,
    ])
    assert.equal(
      (
        await db.query(
          "select id from account_application_questions where id=$1",
          [questionId]
        )
      ).rows.length,
      0
    )
    // The autofill API first records only candidate-submitted answers, then
    // attaches generated fills to the new idle revision. Only later review
    // may teach those fills to the reusable-answer library.
    await db.exec("reset role")
    const suggestionId = "10000000-0000-4000-8000-000000000099"
    await db.exec(
      "insert into job_catalog(id,title,company,country,url) values('suggestion','Engineer','Suggestion QA','Germany','https://synthetic.example.test/suggestion')"
    )
    const unfilled = {
      ...packet,
      company: "Suggestion QA",
      answers: { email: "qa@example.test" },
    }
    await db.query(
      "insert into application_runs(id,user_id,job_id,target_url,status,packet,employer_key) values($1,$2,'suggestion','https://synthetic.example.test/suggestion','ready',$3::jsonb,'suggestion-qa')",
      [suggestionId, alice, JSON.stringify(unfilled)]
    )
    await user(alice)
    await save(suggestionId, 1, unfilled.answers)
    await db.exec("reset role")
    await db.query(
      "update application_runs set packet=$1::jsonb where id=$2 and revision=2 and status='ready'",
      [
        JSON.stringify({
          ...unfilled,
          answers: { ...unfilled.answers, visa: "No" },
        }),
        suggestionId,
      ]
    )
    const suggestionMemory = await db.query<{ answer: unknown }>(
      "select answer from account_application_questions where employer_key='suggestion-qa' and question->>'id'='visa'"
    )
    assert.equal(suggestionMemory.rows.length, 1)
    assert.equal(
      suggestionMemory.rows[0].answer,
      null,
      "Generated fills do not teach answer memory"
    )
    await user(alice)
    await save(suggestionId, 2, { ...unfilled.answers, visa: "No" })
    const reviewedMemory = await db.query<SavedQuestion>(
      "select * from account_application_questions where employer_key='suggestion-qa' and question->>'id'='visa'"
    )
    assert.equal(
      reviewedMemory.rows[0].answer,
      "No",
      "Reviewed candidate answers can teach memory"
    )
    assert.equal(reviewedMemory.rows[0].reuse_scope, "all")
    assert.equal(reviewedMemory.rows[0].reuse_explicit, false)

    // New and optional answers, plus edits to previously prefilled fields, are
    // reusable without a per-field remember payload. Consent stays per run.
    await db.exec("reset role")
    const defaultId = "10000000-0000-4000-8000-000000000097"
    const nextId = "10000000-0000-4000-8000-000000000098"
    const defaultPacket = {
      ...packet,
      fields: [
        ...packet.fields,
        {
          id: "salary",
          label: "Salary expectation",
          help: "Annual EUR",
          kind: "number" as const,
          required: false,
          options: [],
        },
      ],
    }
    for (const [id, company] of [
      [defaultId, "Default QA"],
      [nextId, "Next QA"],
    ]) {
      const jobId = `default-${id}`
      await db.query(
        "insert into job_catalog(id,title,company,country,url) values($1,'Engineer',$2,'Germany','https://synthetic.example.test/' || $1)",
        [jobId, company]
      )
      await db.query(
        "insert into application_runs(id,user_id,job_id,target_url,status,packet,employer_key) values($1,$2,$5,'https://synthetic.example.test/' || $5,'ready',$3::jsonb,lower($4))",
        [
          id,
          alice,
          JSON.stringify({ ...defaultPacket, company }),
          company,
          jobId,
        ]
      )
    }
    const submitted = {
      ...no,
      email: "updated@example.test",
      salary: "90000",
      consent: ["I agree"],
    }
    await user(alice)
    await save(defaultId, 1, submitted)
    const defaultMemory = async () =>
      (
        await db.query<SavedQuestion>(
          "select * from account_application_questions where employer_key='default qa' order by question->>'id'"
        )
      ).rows
    const learned = await defaultMemory()
    assert.equal(learned.length, 4)
    assert.ok(learned.every((q) => q.reuse_explicit === false))
    assert.equal(
      learned.find((q) => q.question.id === "email")?.answer,
      submitted.email
    )
    assert.ok(
      learned.every((q) =>
        q.question.id === "consent"
          ? q.reuse_scope === "never"
          : q.reuse_scope === "all"
      )
    )
    // A stale save without reuse choices must also leave memory untouched.
    await assert.rejects(
      save(defaultId, 1, { ...submitted, visa: "Yes" }),
      /changed/
    )
    assert.deepEqual(await defaultMemory(), learned)

    await db.exec("reset role;set role service_role")
    const nextPacket = {
      ...defaultPacket,
      answers: {},
      fields: defaultPacket.fields.map((field) => ({
        ...field,
        id: `next-${field.id}`,
        step: 1,
      })),
    }
    const nextMemory = await read(nextId, nextPacket.fields)
    const reused = applyRememberedAnswers(nextPacket, nextMemory)
    assert.equal(reused.answers["next-visa"], "No")
    assert.equal(reused.answers["next-email"], submitted.email)
    assert.equal(reused.answers["next-salary"], "90000")
    assert.equal(reused.answers["next-consent"], undefined)
    assert.equal((await read(ids[2], nextPacket.fields)).length, 0)
    assert.equal((await read(ids[3], nextPacket.fields)).length, 0)

    // Explicit limits survive future answer edits with no remember payload.
    await user(alice)
    await save(defaultId, 2, submitted, { visa: "never", salary: "employer" })
    await save(defaultId, 3, { ...submitted, visa: "Yes", salary: "95000" })
    const limited = await defaultMemory()
    assert.equal(
      limited.find((q) => q.question.id === "visa")?.reuse_scope,
      "never"
    )
    assert.equal(
      limited.find((q) => q.question.id === "salary")?.reuse_scope,
      "employer"
    )
    await user(bob)
    await assert.rejects(save(defaultId, 4, submitted), /changed/)
    await db.exec("reset role;set role service_role")
    assert.equal(
      (await read(defaultId)).find((q) => q.question.id === "visa")
        ?.reuse_explicit,
      true
    )
    const limitedNext = applyRememberedAnswers(
      nextPacket,
      await read(nextId, nextPacket.fields)
    )
    assert.equal(limitedNext.answers["next-visa"], undefined)
    assert.equal(limitedNext.answers["next-salary"], undefined)

    await db.exec("reset role;set role anon")
    await assert.rejects(
      db.exec("select * from account_application_questions"),
      /permission denied/
    )
    await assert.rejects(
      db.exec("select application_question_alerts()"),
      /permission denied/
    )
  } finally {
    await db.close()
  }
})
