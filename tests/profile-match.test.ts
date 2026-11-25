import assert from "node:assert/strict"
import test from "node:test"

import {
  countryFromLocation,
  matchProfile,
} from "@/lib/server/sponsor-sources/profile"
import { hasVisaSignal } from "@/lib/server/sponsor-sources/feeds/job-feeds"

test("matchProfile keeps senior AI/full-stack roles and scores them high", () => {
  const ai = matchProfile(
    "Senior Applied AI Engineer",
    "LLM RAG langchain typescript"
  )
  assert.equal(ai.keep, true)
  assert.ok(ai.fitScore >= 70, `expected high fit, got ${ai.fitScore}`)
  assert.equal(ai.resumeVariant, "Applied AI Engineer")

  const founding = matchProfile("Founding Engineer", "react node typescript")
  assert.equal(founding.resumeVariant, "Founding Engineer")
  assert.equal(founding.seniority, "founding")
})

test("matchProfile drops junior and wrong-discipline roles", () => {
  assert.equal(matchProfile("Junior Software Engineer").keep, false)
  assert.equal(matchProfile("Software Engineering Intern").keep, false)
  assert.equal(matchProfile("Account Executive").keep, false)
  assert.equal(matchProfile("Customer Success Manager").keep, false)
})

test("matchProfile keeps a plain senior engineer but scores AI roles higher", () => {
  const plain = matchProfile("Senior Software Engineer")
  const aiRole = matchProfile("Staff AI Engineer", "llm agents rag")
  assert.equal(plain.keep, true)
  assert.ok(aiRole.fitScore > plain.fitScore)
})

test("countryFromLocation resolves EU cities to target countries", () => {
  assert.equal(countryFromLocation("Berlin, Germany"), "Germany")
  assert.equal(countryFromLocation("Amsterdam"), "Netherlands")
  assert.equal(countryFromLocation("Paris, France"), "France")
  assert.equal(countryFromLocation("Lisbon"), "Portugal")
  assert.equal(countryFromLocation("Mars"), null)
})

test("hasVisaSignal detects sponsorship/relocation language", () => {
  assert.equal(
    hasVisaSignal("We offer visa sponsorship and relocation support"),
    true
  )
  assert.equal(hasVisaSignal("Highly skilled migrant permit available"), true)
  assert.equal(hasVisaSignal("Must already have EU work rights"), false)
})
