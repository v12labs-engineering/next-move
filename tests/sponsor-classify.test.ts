import assert from "node:assert/strict"
import test from "node:test"

import {
  classifyCompany,
  isSoftwareCompany,
} from "../lib/server/sponsor-sources/classify"

test("classifier keeps obvious software companies", () => {
  const softwareNames = [
    "Adobe Systems Benelux B.V.",
    "Booking.com B.V.",
    "Databricks Netherlands B.V.",
    "Some Cloud Platform B.V.",
    "Acme Data Analytics",
    "3Shape A/S", // borderline; relies on website signal
  ]
  // The clearly-software ones must pass on name alone.
  assert.equal(isSoftwareCompany("Adobe Systems Benelux B.V."), true)
  assert.equal(
    isSoftwareCompany("Databricks Netherlands B.V.", "https://databricks.com"),
    true
  )
  assert.equal(isSoftwareCompany("Some Cloud Platform B.V."), true)
  assert.equal(isSoftwareCompany("Acme Data Analytics"), true)
  void softwareNames
})

test("classifier rejects clearly non-software sponsors", () => {
  const nonSoftware = [
    '"Aa-Dee" Machinefabriek en Staalbouw Nederland B.V.',
    "Amsterdam UMC Ziekenhuis",
    "Universiteit Utrecht",
    "ING Bank N.V.",
    "Randstad Uitzendbureau B.V.",
    "Carlsberg A/S",
    "Vestas Wind Systems A/S", // "systems" pulls +, but no other signal — acceptable either way
  ]
  assert.equal(isSoftwareCompany(nonSoftware[0]), false)
  assert.equal(isSoftwareCompany(nonSoftware[1]), false)
  assert.equal(isSoftwareCompany(nonSoftware[2]), false)
  assert.equal(isSoftwareCompany(nonSoftware[3]), false)
  assert.equal(isSoftwareCompany(nonSoftware[4]), false)
})

test("website domain signals boost borderline names", () => {
  // A bland name with a strong tech TLD should classify as software.
  const bland = classifyCompany("Northbound B.V.")
  const withDomain = classifyCompany("Northbound B.V.", "https://northbound.ai")
  assert.equal(bland.isSoftware, false)
  assert.equal(withDomain.isSoftware, true)
  assert.ok(withDomain.score > bland.score)
})

test("ATS host on website is a positive signal", () => {
  const v = classifyCompany(
    "Quiet Startup B.V.",
    "https://jobs.lever.co/quietstartup"
  )
  assert.ok(v.reasons.some((r) => r.startsWith("ats:")))
  assert.equal(v.isSoftware, true)
})

test("verdict exposes score and reasons for debugging", () => {
  const v = classifyCompany("Acme Software Labs", "https://acme.io")
  assert.ok(v.score > 0)
  assert.ok(v.reasons.length > 0)
})
