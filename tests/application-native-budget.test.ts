import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { PGlite } from "@electric-sql/pglite"

test("native receipt turns retain approval, terminal-state and quota checks", async () => {
  const db = new PGlite()
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role;
   create table public.application_runs(id uuid primary key,user_id uuid,status text,revision integer,approved_revision integer,decision_attempts integer constraint application_runs_decision_attempts_check check (decision_attempts between 0 and 6));
   create function public.reserve_ai_attempt(uuid) returns boolean language sql as 'select true';
   insert into application_runs values('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','submitting',2,2,0);`)
    for (const migration of [
      "202610310001_application_computer_budget.sql",
      "202611050052_native_agent_receipt_decisions.sql",
      "202611050053_native_agent_turn_budget.sql",
      "202611050054_native_agent_sixty_turns.sql",
    ]) {
      await db.exec(
        await readFile(
          new URL(`../supabase/migrations/${migration}`, import.meta.url),
          "utf8"
        )
      )
    }
    const reserve = async () =>
      (
        await db.query<{ ok: boolean }>(
          `select reserve_application_decision('00000000-0000-4000-8000-000000000001') ok`
        )
      ).rows[0].ok
    assert.equal(await reserve(), true)
    await db.exec("update application_runs set approved_revision=1")
    assert.equal(await reserve(), false)
    await db.exec(
      "update application_runs set approved_revision=2,status='submission_unknown'"
    )
    assert.equal(await reserve(), false)
    await db.exec("update application_runs set status='submitted'")
    assert.equal(await reserve(), false)
    await db.exec(
      "update application_runs set status='submitting',decision_attempts=32"
    )
    assert.equal(await reserve(), true)
    await db.exec("update application_runs set decision_attempts=59")
    assert.equal(await reserve(), true)
    assert.equal(
      (
        await db.query<{ attempts: number }>(
          "select decision_attempts attempts from application_runs"
        )
      ).rows[0].attempts,
      60
    )
    assert.equal(await reserve(), false)
    await assert.rejects(
      db.exec("update application_runs set decision_attempts=61"),
      /application_runs_decision_attempts_check/
    )
    await db.exec(
      "update application_runs set decision_attempts=0;create or replace function public.reserve_ai_attempt(uuid) returns boolean language sql as 'select false'"
    )
    assert.equal(await reserve(), false)
  } finally {
    await db.close()
  }
})
