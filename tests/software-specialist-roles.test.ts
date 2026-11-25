import assert from "node:assert/strict"
import test from "node:test"
import { isSoftwareRole, softwareRoleTitleScope } from "../lib/jobs/software-roles"
import {
  catalogRoleTitleScope,
  classifyJobCategory,
} from "../lib/jobs/categories"

// Real title families and implementation responsibilities observed in public
// career postings; responsibility text is shortened to the relevant evidence.
const implementationRoles = [
  [
    "Applied AI Specialist-Cloud FullStack",
    "Design and build cloud-native and hybrid applications. Operate CI/CD and GitOps pipelines.",
  ],
  [
    "Technical Consultant-AI Integration",
    "Develop connectors and build Retrieval-Augmented Generation (RAG) pipelines for production AI services.",
  ],
  [
    "Package Consultant-SAP Application Extensions",
    "Deliver custom applications with RAP programming and side-by-side application design and development.",
  ],
  [
    "Package Consultant-SAP BTP",
    "Configure and build solutions leveraging SAP AI Core and Generative AI Hub.",
  ],
  [
    "Package Consultant-ServiceNow",
    "Implement production workflows by integrating ServiceNow with other systems, then perform testing and deployment.",
  ],
] as const

test("technical specialist titles reach detail collection and qualify only with implementation evidence", () => {
  for (const [title, description] of implementationRoles) {
    assert.equal(softwareRoleTitleScope(title), "needs_description", title)
    assert.equal(
      catalogRoleTitleScope(title, ["software"]),
      "needs_description",
      title
    )
    assert.equal(isSoftwareRole(title), false, title)
    assert.equal(
      isSoftwareRole(
        title,
        "Our company provides software engineering, AI services and cloud platforms to clients."
      ),
      false,
      title
    )
    assert.equal(isSoftwareRole(title, description), true, title)
    assert.equal(classifyJobCategory(title, description), "software", title)
  }
})

test("functional SAP, generic consultants and AI sales do not become software roles", () => {
  const engineeringDescription = implementationRoles
    .map(([, description]) => description)
    .join(" ")
  for (const title of [
    "Package Consultant-SAP HANA FIN TR",
    "SAP Finance Functional Consultant",
    "Package Consultant-SAP BTP Functional Finance",
    "Business Consultant",
    "Management Consultant",
    "Technical Consultant",
    "AI Specialist",
    "Applied AI Specialist-Cloud FullStack Pre-Sales",
    "Technical Consultant-AI Integration Sales",
    "Package Consultant-ServiceNow Presales",
  ])
    assert.equal(isSoftwareRole(title, engineeringDescription), false, title)
})

test("each specialist discipline requires its own work evidence", () => {
  assert.equal(
    isSoftwareRole(
      "Package Consultant-SAP BTP",
      "Advise finance teams about SAP licensing, accounting controls and business transformation."
    ),
    false
  )
  assert.equal(
    isSoftwareRole(
      "Package Consultant-ServiceNow",
      "Manage incidents, assign tickets and maintain service-level reports."
    ),
    false
  )
  assert.equal(
    isSoftwareRole(
      "Technical Consultant-AI Integration",
      "Demonstrate AI features to prospective customers and advise purchasing decisions."
    ),
    false
  )
  assert.equal(
    isSoftwareRole(
      "Applied AI Specialist-Cloud FullStack",
      "Train colleagues to use AI tools and summarize client strategy presentations."
    ),
    false
  )
})
