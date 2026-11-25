import type { FollowupContact } from "@/lib/server/applications/followup"

const followupQuestions: Record<FollowupContact["reason"], string> = {
  Recruiting:
    "Are you the right person to follow up with about my application?",
  "Related role":
    "I’d appreciate any advice on who to follow up with on the team.",
  "Company leadership":
    "If you know who’s leading the search, I’d appreciate a pointer.",
  "Company employee":
    "Would you happen to know who handles hiring for this role?",
}

export function followupMessage(
  person: FollowupContact,
  title: string,
  company: string
) {
  const name = person.name.trim().split(/\s+/)[0].replace(/,$/, "")
  const role = title.trim().replace(/\s+/g, " ")
  const employer = company.trim().replace(/\s+/g, " ")
  return `Hi ${name}, I applied for ${role ? `the ${role} role` : "a role"} at ${employer}. ${followupQuestions[person.reason]} Thanks!`
}
