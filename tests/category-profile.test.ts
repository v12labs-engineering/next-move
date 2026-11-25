import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { load } from "cheerio"
import {
  candidateSchema,
  emptyCandidate,
  type Candidate,
} from "@/lib/candidate"
import { newOnboardingCandidate } from "@/lib/candidate/onboarding"
import { jobCategoryIds, jobCategoryLabels } from "@/lib/jobs/categories"
import { JobCategoryFields } from "@/components/onboarding/onboarding-sections"

const profile: Candidate = {
  ...emptyCandidate,
  fullName: "Alex Example",
  headline: "Product Designer",
  targetRoles: ["Product Designer"],
  skills: ["Figma"],
  targetCountries: ["India"],
  resumeText:
    "Designed accessible customer journeys and tested product interactions with users. ".repeat(
      3
    ),
}

test("profile categories are explicit, bounded choices and deduplicate on save", () => {
  assert.deepEqual(
    candidateSchema.parse({
      ...profile,
      jobCategories: ["design", "product", "design"],
    }).jobCategories,
    ["design", "product"]
  )
  assert.deepEqual(
    candidateSchema.parse({ ...profile, jobCategories: [...jobCategoryIds] })
      .jobCategories,
    [...jobCategoryIds]
  )
  for (const jobCategories of [
    [],
    ["unknown"],
    "design",
    Array(9).fill("software"),
  ])
    assert.equal(
      candidateSchema.safeParse({ ...profile, jobCategories }).success,
      false
    )
})

test("legacy profiles stay valid and new profiles start with the software category", () => {
  const legacy = { ...profile }
  delete legacy.jobCategories
  assert.equal(candidateSchema.parse(legacy).jobCategories, undefined)
  assert.deepEqual(emptyCandidate.jobCategories, ["software"])
  assert.deepEqual(newOnboardingCandidate().jobCategories, ["software"])
  assert.deepEqual(newOnboardingCandidate().targetCountries, ["India"])
})

test("category controls expose saved selections with labels and retain at least one", () => {
  const $ = load(
    renderToStaticMarkup(
      createElement(JobCategoryFields, {
        selected: ["design", "product"],
        onChange: () => {},
      })
    )
  )
  assert.equal($("fieldset legend").text(), "Job categories")
  assert.equal($("fieldset").attr("aria-describedby"), "job-categories-help")
  assert.equal($("input[type=checkbox]").length, jobCategoryIds.length)
  assert.deepEqual(
    $("input:checked")
      .map((_, node) => $(node).val())
      .get()
      .sort(),
    ["design", "product"]
  )
  assert.equal($("input:disabled").length, 0)
  for (const category of jobCategoryIds) {
    const input = $(`input[value=${category}]`)
    assert.equal(input.attr("name"), "jobCategories")
    assert.equal(
      input.parent("label").text().trim(),
      jobCategoryLabels[category]
    )
  }
  const one = load(
    renderToStaticMarkup(
      createElement(JobCategoryFields, {
        selected: ["sales"],
        onChange: () => {},
      })
    )
  )
  assert.equal(one("input:checked").val(), "sales")
  assert.equal(one("input:disabled").val(), "sales")
  assert.equal(one("input:disabled").length, 1)
})

test("legacy category controls show software and saving disables the group", () => {
  const $ = load(
    renderToStaticMarkup(
      createElement(JobCategoryFields, {
        onChange: () => {},
        disabled: true,
      })
    )
  )
  assert.equal($("input:checked").val(), "software")
  assert.ok($("fieldset").is("[disabled]"))
})
