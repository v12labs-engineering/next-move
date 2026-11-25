export const applicationStatusGroups = {
  needs: ["ready", "needs_attention", "submission_unknown"],
  queue: ["queued_prepare", "queued"],
  flight: ["preparing", "running", "submitting"],
  submitted: ["submitted"],
  cancelled: ["cancelled"],
} as const

export type RunGroup = keyof typeof applicationStatusGroups
export type ApplicationCounts = Record<RunGroup | "all", number>

export const emptyApplicationCounts: ApplicationCounts = {
  all: 0,
  needs: 0,
  queue: 0,
  flight: 0,
  submitted: 0,
  cancelled: 0,
}
