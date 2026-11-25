import { z } from "zod"

export const applicationFieldDescription = z.object({
  targets: z.array(z.string()).min(1).max(100),
  label: z.string().min(1).max(2000),
  kind: z.enum([
    "text",
    "email",
    "url",
    "tel",
    "number",
    "textarea",
    "radio",
    "checkbox",
    "select",
    "combobox",
    "yesno",
    "resume",
    "cover_letter",
    "unsupported",
  ]),
  required: z.boolean(),
  options: z.array(z.string().max(1000)).max(500),
})

export type ApplicationFormPlanner = "computer" | "browser-use"
export function applicationFormPlanner(
  value = process.env.APPLICATION_FORM_PLANNER
): ApplicationFormPlanner {
  if (!value || value === "browser-use") return "browser-use"
  if (value === "computer") return "computer"
  throw new Error("Application form planner is not configured")
}
