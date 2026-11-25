import { createHash } from "node:crypto"

export const hourlyFirecrawlBoards = [
  "cyberpark",
  "e2ehiring",
  "egig",
  "shine",
  "shipmates",
  "technopark",
] as const

export type BoardIndexLead = { url: string; fingerprint: string }

export type BoardIndexRefresh = {
  select(leads: readonly BoardIndexLead[]): Promise<ReadonlySet<string>>
  checked(lead: BoardIndexLead): void
}

export function boardIndexLead(url: URL, evidence: unknown): BoardIndexLead {
  return {
    url: url.href,
    fingerprint: createHash("sha256")
      .update(JSON.stringify(evidence))
      .digest("hex"),
  }
}

export async function selectBoardDetails<T extends BoardIndexLead>(
  leads: T[],
  refresh?: BoardIndexRefresh
) {
  if (!refresh || leads.length === 0) return leads
  const selected = await refresh.select(
    leads.map(({ url, fingerprint }) => ({ url, fingerprint }))
  )
  return leads.filter(({ url }) => selected.has(url))
}
