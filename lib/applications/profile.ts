import { z } from "zod"
import { countryName } from "../location/countries"
import { resumeContacts } from "../resume/contact"

const country = z
  .string()
  .refine((value) => countryName(value) === value, "Choose a country.")
const optionalEmail = z.union([z.literal(""), z.email().max(254)])
const optionalUrl = z.union([
  z.literal(""),
  z
    .url()
    .max(500)
    .refine((value) => /^https:\/\//i.test(value), "Use an HTTPS link."),
])
const nullableChoice = z.boolean().nullable()
// Shared ISO currency snapshot (Node ICU, 2026-10-31). Server and browser ICU
// releases differ; runtime enumeration would produce hydration mismatches.
export const applicationCurrencies: readonly string[] = [
  "AED",
  "AFN",
  "ALL",
  "AMD",
  "ANG",
  "AOA",
  "ARS",
  "AUD",
  "AWG",
  "AZN",
  "BAM",
  "BBD",
  "BDT",
  "BGN",
  "BHD",
  "BIF",
  "BMD",
  "BND",
  "BOB",
  "BRL",
  "BSD",
  "BTN",
  "BWP",
  "BYN",
  "BZD",
  "CAD",
  "CDF",
  "CHF",
  "CLP",
  "CNY",
  "COP",
  "CRC",
  "CUC",
  "CUP",
  "CVE",
  "CZK",
  "DJF",
  "DKK",
  "DOP",
  "DZD",
  "EGP",
  "ERN",
  "ETB",
  "EUR",
  "FJD",
  "FKP",
  "GBP",
  "GEL",
  "GHS",
  "GIP",
  "GMD",
  "GNF",
  "GTQ",
  "GYD",
  "HKD",
  "HNL",
  "HRK",
  "HTG",
  "HUF",
  "IDR",
  "ILS",
  "INR",
  "IQD",
  "IRR",
  "ISK",
  "JMD",
  "JOD",
  "JPY",
  "KES",
  "KGS",
  "KHR",
  "KMF",
  "KPW",
  "KRW",
  "KWD",
  "KYD",
  "KZT",
  "LAK",
  "LBP",
  "LKR",
  "LRD",
  "LSL",
  "LYD",
  "MAD",
  "MDL",
  "MGA",
  "MKD",
  "MMK",
  "MNT",
  "MOP",
  "MRU",
  "MUR",
  "MVR",
  "MWK",
  "MXN",
  "MYR",
  "MZN",
  "NAD",
  "NGN",
  "NIO",
  "NOK",
  "NPR",
  "NZD",
  "OMR",
  "PAB",
  "PEN",
  "PGK",
  "PHP",
  "PKR",
  "PLN",
  "PYG",
  "QAR",
  "RON",
  "RSD",
  "RUB",
  "RWF",
  "SAR",
  "SBD",
  "SCR",
  "SDG",
  "SEK",
  "SGD",
  "SHP",
  "SLE",
  "SLL",
  "SOS",
  "SRD",
  "SSP",
  "STN",
  "SVC",
  "SYP",
  "SZL",
  "THB",
  "TJS",
  "TMT",
  "TND",
  "TOP",
  "TRY",
  "TTD",
  "TWD",
  "TZS",
  "UAH",
  "UGX",
  "USD",
  "UYU",
  "UZS",
  "VES",
  "VND",
  "VUV",
  "WST",
  "XAF",
  "XCD",
  "XCG",
  "XDR",
  "XOF",
  "XPF",
  "XSU",
  "YER",
  "ZAR",
  "ZMW",
  "ZWG",
  "ZWL",
]
export const applicationProfileSchema = z
  .object({
    enabled: z.boolean().default(false),
    confirmedAt: z.iso.datetime().nullable().default(null),
    contact: z
      .object({
        preferredName: z.string().trim().max(120).default(""),
        givenName: z.string().trim().max(120).default(""),
        familyName: z.string().trim().max(120).default(""),
        location: z.string().trim().max(120).default(""),
        email: optionalEmail.default(""),
        phone: z.string().trim().max(50).default(""),
        linkedin: optionalUrl.default(""),
        github: optionalUrl.default(""),
        portfolio: optionalUrl.default(""),
      })
      .strict()
      .default({
        preferredName: "",
        givenName: "",
        familyName: "",
        location: "",
        email: "",
        phone: "",
        linkedin: "",
        github: "",
        portfolio: "",
      }),
    eligibility: z
      .array(
        z
          .object({
            country,
            authorized: nullableChoice,
            sponsorshipNow: nullableChoice,
            sponsorshipFuture: nullableChoice,
          })
          .strict()
      )
      .max(8)
      .default([]),
    noticeDays: z.number().int().min(0).max(365).nullable().default(null),
    earliestStart: z.iso.date().nullable().default(null),
    willingToRelocate: nullableChoice.default(null),
    willingToTravel: nullableChoice.default(null),
    compensation: z
      .array(
        z
          .object({
            country,
            minimum: z.number().positive().max(1_000_000_000).nullable(),
            maximum: z.number().positive().max(1_000_000_000).nullable(),
            singleAmount: z.number().positive().max(1_000_000_000).nullable(),
            currency: z
              .string()
              .refine(
                (value) =>
                  value === "" || applicationCurrencies.includes(value),
                "Choose a currency."
              ),
            period: z.enum(["year", "month", "hour"]),
            basis: z.enum(["base", "total"]),
          })
          .strict()
          .superRefine((value, ctx) => {
            if (value.minimum !== null && !value.currency)
              ctx.addIssue({
                code: "custom",
                path: ["currency"],
                message: "Choose a currency for your salary range.",
              })
            if ((value.minimum === null) !== (value.maximum === null))
              ctx.addIssue({
                code: "custom",
                path: ["minimum"],
                message: "Enter both ends of the salary range.",
              })
            if (
              value.minimum !== null &&
              value.maximum !== null &&
              value.minimum > value.maximum
            )
              ctx.addIssue({
                code: "custom",
                path: ["maximum"],
                message: "Maximum must be at least the minimum.",
              })
            if (
              value.singleAmount !== null &&
              (value.minimum === null ||
                value.maximum === null ||
                value.singleAmount < value.minimum ||
                value.singleAmount > value.maximum)
            )
              ctx.addIssue({
                code: "custom",
                path: ["singleAmount"],
                message: "Choose an amount within your range.",
              })
          })
      )
      .max(8)
      .default([]),
    careerInterests: z.string().trim().max(1500).default(""),
    generateWrittenAnswers: z.boolean().default(false),
  })
  .strict()
  .superRefine((profile, ctx) => {
    for (const key of ["eligibility", "compensation"] as const) {
      const countries = profile[key].map((row) => row.country)
      if (new Set(countries).size !== countries.length)
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "Use one entry per country.",
        })
    }
  })
export type ApplicationProfile = z.infer<typeof applicationProfileSchema>
export const emptyApplicationProfile = applicationProfileSchema.parse({})

// Suggestions from the resume; saving the form confirms them.
export function applicationProfileFromResume(
  resumeText: string,
  email = "",
  identity: { fullName?: string; location?: string | null } = {}
): ApplicationProfile {
  const contacts = resumeContacts(resumeText)
  const name = identity.fullName?.trim().split(/\s+/) ?? []
  return applicationProfileSchema.parse({
    enabled: true,
    contact: {
      ...contacts,
      givenName: name.length === 2 ? name[0] : "",
      familyName: name.length === 2 ? name[1] : "",
      location: identity.location?.slice(0, 120) ?? "",
      email: contacts.email || email,
      linkedin: contacts.linkedin?.startsWith("https://")
        ? contacts.linkedin
        : "",
      github: contacts.github?.startsWith("https://") ? contacts.github : "",
    },
  })
}

export function applicationProfileFresh(
  profile: ApplicationProfile,
  now = new Date()
) {
  return (
    profile.enabled &&
    !!profile.confirmedAt &&
    Date.parse(profile.confirmedAt) <= now.getTime()
  )
}

// A client cannot renew facts with a future timestamp. Confirmation is stamped
// by the profile route, only when the candidate explicitly confirms the form.
export function confirmApplicationProfile(
  next: ApplicationProfile,
  previous: ApplicationProfile | undefined,
  now = new Date()
): ApplicationProfile {
  const { confirmedAt: requested, ...details } = next
  const { confirmedAt: oldDate, ...oldDetails } =
    previous ?? emptyApplicationProfile
  const changed = JSON.stringify(details) !== JSON.stringify(oldDetails)
  const reconfirmed = requested !== null && requested !== oldDate
  return {
    ...next,
    confirmedAt:
      !next.enabled || requested === null
        ? null
        : changed || reconfirmed
          ? now.toISOString()
          : oldDate,
  }
}
