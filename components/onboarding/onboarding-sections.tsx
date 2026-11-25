"use client"

import { type Candidate } from "@/lib/candidate"
import { Label } from "@/components/ui/label"
import {
  jobCategoryIds,
  jobCategoryLabels,
  type JobCategory,
} from "@/lib/jobs/categories"
import { cn } from "@/lib/utils"

export function JobCategoryFields({
  selected = ["software"],
  onChange,
  disabled = false,
}: {
  selected?: JobCategory[]
  onChange: (categories: JobCategory[]) => void
  disabled?: boolean
}) {
  return (
    <fieldset
      className="min-w-0 space-y-3"
      aria-describedby="job-categories-help"
      disabled={disabled}
    >
      <legend className="text-sm font-medium">Job categories</legend>
      <p id="job-categories-help" className="text-[13px] text-muted-foreground">
        Choose at least one. We match jobs in these categories to your search
        roles and skills. Replacing your resume keeps these choices.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        {jobCategoryIds.map((category) => {
          const checked = selected.includes(category)
          return (
            <label
              key={category}
              className={cn(
                "flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-sm",
                checked && "border-primary bg-primary/5"
              )}
            >
              <input
                type="checkbox"
                name="jobCategories"
                value={category}
                checked={checked}
                disabled={checked && selected.length === 1}
                className="size-4 accent-primary"
                onChange={(event) => {
                  if (event.target.checked) onChange([...selected, category])
                  else if (selected.length > 1)
                    onChange(selected.filter((value) => value !== category))
                }}
              />
              {jobCategoryLabels[category]}
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}

const stepLabels = ["Resume", "Review", "Answers", "Auto-apply"]

export function StepIndicator({ current }: { current: number }) {
  return (
    <ol className="grid grid-cols-4 gap-2" aria-label="Profile setup progress">
      {stepLabels.map((label, index) => {
        const number = index + 1
        const complete = number < current
        const active = number === current
        return (
          <li
            key={label}
            className="min-w-0 space-y-2"
            aria-current={active ? "step" : undefined}
          >
            <span
              aria-hidden="true"
              className={cn(
                "block h-1 rounded-full bg-muted-foreground/15",
                complete && "bg-primary/40",
                active && "bg-primary"
              )}
            />
            <span
              className={cn(
                "block text-center text-[10px] sm:text-xs",
                active ? "font-medium text-foreground" : "text-muted-foreground"
              )}
            >
              <span className="sr-only">
                Step {number} of {stepLabels.length}:{" "}
              </span>
              {label}
              {complete && <span className="sr-only"> (complete)</span>}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

export function StepFooter({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 border-t px-5 py-4 sm:px-6">
      {children}
    </div>
  )
}

export function SettingsSection({
  id,
  title,
  description,
  children,
}: {
  id: string
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <section
      aria-labelledby={id}
      className="grid gap-5 rounded-xl border bg-card p-4 shadow-xs sm:p-6 lg:grid-cols-[minmax(0,13rem)_minmax(0,1fr)] lg:gap-8"
    >
      <div>
        <h2
          id={id}
          className="scroll-mt-40 text-sm font-semibold tracking-tight lg:scroll-mt-6"
        >
          {title}
        </h2>
        <p className="mt-1.5 max-w-[38ch] text-[13px] leading-relaxed text-muted-foreground">
          {description}
        </p>
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  )
}

export function ResumeSections({ candidate }: { candidate: Candidate }) {
  const insights = candidate.resumeInsights!
  return (
    <div className="space-y-5">
      {insights.experience.length > 0 && (
        <section aria-label="Career history">
          <h3 className="text-xs font-medium text-muted-foreground">
            Career history
          </h3>
          <ul className="mt-2 space-y-3">
            {insights.experience.map((job, index) => (
              <li key={index}>
                <p className="text-sm font-medium">
                  {job.title} · {job.company}
                </p>
                <p className="text-xs text-muted-foreground">
                  {job.startYear ?? "Start date unknown"} –{" "}
                  {job.current
                    ? "Present"
                    : (job.endYear ?? "End date unknown")}
                </p>
                <Source quote={job.quote} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {insights.education.length > 0 && (
        <section aria-label="Education">
          <h3 className="text-xs font-medium text-muted-foreground">
            Education
          </h3>
          {insights.education.map((item, index) => (
            <div className="mt-2 text-sm" key={index}>
              {item.qualification} · {item.institution}
              <Source quote={item.quote} />
            </div>
          ))}
        </section>
      )}
      {insights.projects.length > 0 && (
        <section aria-label="Projects">
          <h3 className="text-xs font-medium text-muted-foreground">
            Projects
          </h3>
          {insights.projects.map((item, index) => (
            <div className="mt-2 text-sm" key={index}>
              {item.value}
              <Source quote={item.quote} />
            </div>
          ))}
        </section>
      )}
      {insights.achievements.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm font-medium text-muted-foreground transition-colors duration-150 ease-out-expo hover:text-foreground">
            Highlights from your resume
          </summary>
          <ul className="mt-2 list-disc space-y-2 pl-5 text-sm">
            {insights.achievements.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}
function Source({ quote }: { quote: string }) {
  return (
    <details className="mt-1 text-xs text-muted-foreground">
      <summary className="cursor-pointer transition-colors duration-150 ease-out-expo hover:text-foreground">
        Source passage
      </summary>
      <blockquote className="mt-2 rounded-md bg-muted/50 p-2.5 whitespace-pre-wrap">
        {quote}
      </blockquote>
    </details>
  )
}
export function Field({
  label,
  id,
  children,
}: {
  label: string
  id: string
  children: React.ReactNode
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  )
}
