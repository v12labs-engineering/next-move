import { z } from "zod"
import { jobCategoryIds } from "@/lib/jobs/categories"
import {
  employmentTypes,
  experienceLevels,
  salaryFilters,
} from "@/lib/jobs/posting-details"
import type { SimpleAppState } from "@/lib/jobs"

export const matchPostingWindows = ["day", "week", "month"] as const
export const matchWorkModes = ["remote", "hybrid", "onsite", "unknown"] as const
export const matchJobStatuses = [
  "all",
  "new",
  "interested",
  "applied",
  "dismissed",
] as const

export const matchPageFilters = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(25),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  country: z.string().max(100).default("all"),
  visa: z
    .enum(["all", "confirmed", "strong", "possible", "weak", "no"])
    .default("all"),
  strict: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  hidden: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  sort: z.enum(["score", "newest"]).default("score"),
  datePosted: z.enum(matchPostingWindows).default("month"),
  view: z.enum(["jobs", "saved", "all"]).default("all"),
  since: z.iso.datetime({ offset: true }).optional(),
  query: z.string().trim().max(200).optional(),
  city: z.string().trim().max(120).optional(),
  company: z.string().trim().max(200).optional(),
  workMode: z.enum(matchWorkModes).optional(),
  category: z.enum(jobCategoryIds).optional(),
  employmentType: z.enum([...employmentTypes, "unknown"]).optional(),
  experienceLevel: z.enum([...experienceLevels, "unknown"]).optional(),
  salary: z.enum(salaryFilters).optional(),
  jobStatus: z.enum(matchJobStatuses).optional(),
  generation: z.uuid().optional(),
})

export interface MatchPage {
  generation: string | null
  state: SimpleAppState
  total: number
  offset: number
  limit: number
  counts: { toReview: number; confirmed: number; fresh: number; new: number }
  matching: {
    status: "pending" | "running" | "ready" | "failed"
    stale: boolean
    profileCurrent: boolean
    computedAt: string | null
    retryAt: string | null
  }
}
