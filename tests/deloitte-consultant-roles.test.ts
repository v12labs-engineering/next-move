import assert from "node:assert/strict"
import { test } from "node:test"
import { isSoftwareRole, softwareRoleTitleScope } from "@/lib/jobs/software-roles"

test("verified .NET and Power Platform consultant titles require implementation evidence", () => {
  for (const [title, evidence] of [
    [
      "Consultant | .NET | Bengaluru | SAP | DSA SAP Accounts",
      "Design, develop, and maintain applications using C#, .NET Core / modern .NET, and ASP.NET Core. Build and integrate REST APIs and microservices.",
    ],
    [
      "Senior Consultant | Microsoft Power Platforms | Bengaluru | Emerging ERP Solutions",
      "Develop, configure, test, deploy, and support business solutions using Microsoft Power Platform. Build Power BI reports and dashboards and integrate solutions with REST APIs.",
    ],
  ]) {
    assert.equal(softwareRoleTitleScope(title), "needs_description")
    assert.equal(isSoftwareRole(title), false)
    assert.equal(
      isSoftwareRole(
        title,
        "Our company builds software and uses AI to transform businesses."
      ),
      false
    )
    assert.equal(isSoftwareRole(title, evidence), true)
  }
})

test("functional and planning consultant jobs remain outside software scope", () => {
  for (const [title, evidence] of [
    [
      "Senior Consultant | Oracle PLM Tech | Bengaluru | Oracle",
      "Oracle GTM Implementation: Leading functional design documentation, configuration documents, and solution blueprints.",
    ],
    [
      "Senior Consultant | SAP Analytics Cloud/SAC | Bengaluru | SAP",
      "Design and develop SAC Planning models for Financial, Workforce, CAPEX and other enterprise planning scenarios. Implement budgeting, forecasting and variance analysis solutions.",
    ],
    [
      "Functional Consultant | Microsoft Power Platform",
      "Develop applications using Microsoft Power Platform.",
    ],
    ["Sales Consultant | .NET", "Design and develop applications using .NET."],
    [
      "Consultant | .NET",
      "Train client teams to use .NET products and prepare functional configuration documentation.",
    ],
  ])
    assert.equal(isSoftwareRole(title, evidence), false, title)
})
