"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import {
  candidateSchema,
  emptyCandidate,
  type Candidate,
} from "@/lib/candidate"
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleCheck,
  FileUp,
  LoaderCircle,
  RefreshCw,
} from "lucide-react"
import { LocationPicker } from "@/components/onboarding/location-picker"
import { Button } from "@/components/ui/button"
import { Chip } from "@/components/ui/chip"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { JOB_SEARCH_COUNTRY } from "@/lib/location/countries"
import {
  meetsOnboardingExperience,
  MIN_ONBOARDING_EXPERIENCE_YEARS,
  newOnboardingCandidate,
  onboardingExperienceMessage,
} from "@/lib/candidate/onboarding"
import { DEFAULT_AUTO_APPLY_SCORE } from "@/lib/applications/auto-apply"
import { cn } from "@/lib/utils"
import { ApplicationProfileFields } from "@/components/applications/application-profile-fields"
import {
  applicationProfileFromResume,
  applicationProfileFresh,
  applicationProfileSchema,
} from "@/lib/applications/profile"
import {
  JobCategoryFields,
  StepIndicator,
  StepFooter,
  SettingsSection,
  ResumeSections,
  Field,
} from "./onboarding-sections"

const textareaClass =
  "min-h-48 w-full rounded-lg border border-input bg-background px-3 py-2 text-base sm:text-sm transition-[border-color,box-shadow] duration-150 ease-out-expo focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none disabled:opacity-50"
const split = (value: string) =>
  value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)

const backgroundFields = [
  { key: "fullName", id: "full-name", label: "full name" },
  { key: "headline", id: "headline", label: "professional headline" },
  { key: "skills", id: "skills", label: "skills" },
  { key: "targetRoles", id: "roles", label: "search roles" },
] as const

function invalidBackgroundFields(
  candidate: Pick<Candidate, (typeof backgroundFields)[number]["key"]>
) {
  return backgroundFields.filter(
    ({ key }) => !candidateSchema.shape[key].safeParse(candidate[key]).success
  )
}

export function OnboardingForm({
  initial,
  editing,
  version = 0,
}: {
  initial?: Candidate
  editing?: "profile" | "preferences"
  version?: number
}) {
  const router = useRouter()
  const [candidate, setCandidate] = useState(
    () =>
      initial ??
      (editing
        ? { ...emptyCandidate, targetCountries: [JOB_SEARCH_COUNTRY] }
        : newOnboardingCandidate())
  )
  const [stage, setStage] = useState<"resume" | "review">(
    initial ? "review" : "resume"
  )
  const [roles, setRoles] = useState(initial?.targetRoles.join(", ") ?? "")
  const [skills, setSkills] = useState(initial?.skills.join(", ") ?? "")
  const [excluded, setExcluded] = useState(
    initial?.excludedCompanies.join(", ") ?? ""
  )
  const [step, setStep] = useState<"background" | "questions" | "applications">(
    "background"
  )
  const [savedVersion, setSavedVersion] = useState(version)
  const [notice, setNotice] = useState("")
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [showBackgroundIssues, setShowBackgroundIssues] = useState(false)
  const [resumeText, setResumeText] = useState("")
  const [fileName, setFileName] = useState("")
  const [pending, setPending] = useState(false)
  const [importing, setImporting] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [redirecting, setRedirecting] = useState(false)
  const [error, setError] = useState("")
  function update<K extends keyof Candidate>(key: K, value: Candidate[K]) {
    setCandidate((c) => ({ ...c, [key]: value }))
  }
  const backgroundIssues = invalidBackgroundFields({
    ...candidate,
    targetRoles: split(roles),
    skills: split(skills),
  })
  const needsDetails = backgroundIssues.length > 0
  const needsExperience =
    !editing && !meetsOnboardingExperience(candidate.experienceYears)
  function backgroundIssueProps(id: string) {
    if (
      !showBackgroundIssues ||
      !backgroundIssues.some((field) => field.id === id)
    )
      return
    return {
      "aria-invalid": true,
      "aria-describedby": "onboarding-background-error",
    }
  }
  const insights = candidate.resumeInsights
  function review(next: Candidate) {
    setCandidate({
      ...next,
      jobCategories:
        next.jobCategories ?? candidate.jobCategories ?? ["software"],
      autoApply: candidate.autoApply,
      targetCountries: candidate.targetCountries,
      targetLocations: candidate.targetLocations ?? [],
      applicationProfile:
        candidate.applicationProfile ??
        applicationProfileFromResume(next.resumeText, "", {
          fullName: next.fullName,
          location: next.currentLocation,
        }),
    })
    setRoles(next.targetRoles.join(", "))
    setSkills(next.skills.join(", "))
    setExcluded(next.excludedCompanies.join(", "))
    setDetailsOpen(
      invalidBackgroundFields(next).length > 0 ||
        (!editing && !meetsOnboardingExperience(next.experienceYears))
    )
    setShowBackgroundIssues(false)
    setStep("background")
    setStage("review")
  }

  async function analyze() {
    setPending(true)
    setError("")
    try {
      const response = await fetch("/api/profile/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resumeText }),
      })
      const data = await response.json()
      if (!response.ok)
        throw new Error(data.error ?? "Could not read your resume.")
      review(
        initial
          ? {
              ...data.candidate,
              workModes: candidate.workModes,
              sponsorshipRequired: candidate.sponsorshipRequired,
              remoteFromHome: candidate.remoteFromHome,
              autoApply: candidate.autoApply,
              excludedCompanies: split(excluded),
            }
          : data.candidate
      )
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not read your resume."
      )
    } finally {
      setPending(false)
    }
  }
  async function save(fillWaiting = false) {
    setError("")
    setNotice("")
    const result = candidateSchema.safeParse({
      ...candidate,
      targetRoles: split(roles),
      skills: split(skills),
      excludedCompanies: split(excluded),
    })
    if (!result.success) {
      const labels: Record<string, string> = {
        fullName: "name",
        headline: "professional headline",
        targetRoles: "search roles",
        jobCategories: "job categories (choose at least one)",
        skills: "skills",
        experienceYears: "years of professional experience",
        targetLocations: "preferred cities",
        workModes: "work preferences",
        resumeText: "resume text",
        applicationProfile:
          "application details (check salary ranges, links and formats)",
      }
      setError(
        `Please check ${[...new Set(result.error.issues.map((i) => labels[String(i.path[0])] ?? "profile details"))].join(", ")}.`
      )
      return
    }
    // Saving the form is the confirmation; the server stamps the time.
    if (
      result.data.applicationProfile?.enabled &&
      !applicationProfileFresh(result.data.applicationProfile)
    )
      result.data.applicationProfile.confirmedAt = new Date().toISOString()
    setPending(true)
    try {
      const response = await fetch("/api/profile", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "If-Match": String(savedVersion),
        },
        body: JSON.stringify(result.data),
      })
      const data = await response.json()
      if (!response.ok)
        throw new Error(data.error ?? "Could not save your profile.")
      setSavedVersion(data.version)
      if (fillWaiting) {
        const filled = await fetch("/api/applications/fill-profile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ continueAutomatic: true }),
        })
        const result = await filled.json()
        if (!filled.ok)
          throw new Error(
            `Your profile was saved. ${result.error || "Waiting applications could not be updated. Try again."}`
          )
        setNotice(
          `${result.updated} application(s) updated; ${result.queued} automatic application(s) queued to continue.${result.skipped ? ` ${result.skipped} changed or could not be updated; review them in Applications.` : ""}`
        )
        window.dispatchEvent(new Event("application-questions-changed"))
      } else {
        setRedirecting(true)
        router.push("/jobs")
      }
      router.refresh()
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not save your profile."
      )
    } finally {
      setPending(false)
    }
  }

  async function importResume(file: File) {
    setError("")
    setFileName("")
    setResumeText("")
    if (file.size > 2_000_000) {
      setError("Choose a file smaller than 2 MB.")
      return
    }
    setImporting(true)
    try {
      const response = await fetch("/api/resume/import", {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-File-Name": encodeURIComponent(file.name),
        },
        body: file,
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? "Resume import failed.")
      setResumeText(data.text)
      setFileName(file.name)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Resume import failed.")
    } finally {
      setImporting(false)
    }
  }

  function continueToQuestions() {
    setError("")
    if (needsDetails || needsExperience) {
      setDetailsOpen(true)
      setShowBackgroundIssues(true)
      const fieldId = backgroundIssues[0]?.id ?? "years"
      requestAnimationFrame(() => document.getElementById(fieldId)?.focus())
      return
    }
    setShowBackgroundIssues(false)
    setStep("questions")
  }
  function replaceResume() {
    setStage("resume")
    setResumeText("")
    setFileName("")
    setError("")
  }

  const errorMessage = error && (
    <p role="alert" className="text-sm text-destructive">
      {error}
    </p>
  )

  const resumeFields = (
    <div className="space-y-5">
      <div className="grid gap-2">
        <p className="text-sm font-medium">Upload your resume</p>
        <label
          className={cn(
            "flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed bg-muted/40 px-4 py-8 text-center transition-[background-color,border-color,box-shadow] duration-150 ease-out-expo focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 hover:border-primary/60 hover:bg-primary/5",
            dragging && "border-primary bg-primary/5",
            (pending || importing) && "pointer-events-none opacity-60"
          )}
          onDragOver={(e) => {
            e.preventDefault()
            if (!pending && !importing) setDragging(true)
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null))
              setDragging(false)
          }}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            if (pending || importing) return
            const file = e.dataTransfer.files[0]
            if (!file) return
            if (!/\.(pdf|docx|txt)$/i.test(file.name)) {
              setError("Choose a PDF, DOCX or text file.")
              return
            }
            void importResume(file)
          }}
        >
          <FileUp
            className={cn(
              "size-8 text-muted-foreground transition-[color,transform] duration-150 ease-out-expo",
              dragging && "text-primary motion-safe:-translate-y-0.5"
            )}
            aria-hidden="true"
          />
          <span className="text-sm font-medium">
            Drop your resume (PDF or DOCX) or{" "}
            <span className="text-primary underline underline-offset-4">
              browse
            </span>
          </span>
          <span
            id="resume-file-help"
            className="text-[13px] text-muted-foreground"
          >
            PDF, DOCX or text, up to 2 MB. Scanned PDFs need a text version.
          </span>
          <input
            id="resume-file"
            type="file"
            accept=".pdf,.docx,.txt"
            className="sr-only"
            aria-describedby="resume-file-help"
            disabled={pending || importing}
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void importResume(file)
            }}
          />
        </label>
      </div>
      {importing && (
        <p
          role="status"
          className="flex items-center gap-2 text-sm text-muted-foreground"
        >
          <LoaderCircle
            className="size-4 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
          Reading your file…
        </p>
      )}
      {fileName && (
        <div
          role="status"
          className="flex animate-in items-start gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4 duration-200 ease-out-expo fade-in slide-in-from-bottom-2 motion-reduce:animate-none"
        >
          <CircleCheck
            className="mt-0.5 size-5 shrink-0 text-emerald-600 dark:text-emerald-400"
            aria-hidden="true"
          />
          <div className="min-w-0 space-y-1">
            <p className="truncate text-sm font-medium">{fileName}</p>
            <p className="text-[13px] text-muted-foreground">
              {resumeText.trim().split(/\s+/).filter(Boolean).length} words
              extracted. Build your profile next, or review the text below.
            </p>
          </div>
        </div>
      )}
      <details open={!fileName || undefined} className="group">
        <summary className="cursor-pointer text-sm font-medium text-muted-foreground transition-colors duration-150 ease-out-expo hover:text-foreground">
          {fileName ? "Review extracted text" : "Or paste your resume"}
        </summary>
        <div className="mt-3">
          <Field label="Resume text" id="resume-text">
            <textarea
              id="resume-text"
              className={textareaClass}
              maxLength={30000}
              value={resumeText}
              disabled={pending || importing}
              onChange={(e) => {
                setResumeText(e.target.value)
                setFileName("")
              }}
            />
          </Field>
        </div>
      </details>
      <p className="text-xs text-muted-foreground">
        When you select Build my profile, your resume text is sent to our AI
        provider to extract your background. Review it before saving. Uploaded
        files are processed for text and are not stored. Profile analysis,
        tailoring, written answers and application navigation share your plan’s
        AI allowance.
      </p>
      {error && (
        <div className="space-y-3">
          {errorMessage}
          {resumeText.trim().length >= 100 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                review({
                  ...emptyCandidate,
                  resumeText,
                })
                setStage("review")
                setError("")
              }}
            >
              Review manually instead
            </Button>
          )}
        </div>
      )}
    </div>
  )

  const resumeActions = (
    <>
      {candidate.resumeText && (
        <Button
          type="button"
          variant="ghost"
          disabled={pending || importing}
          onClick={() => {
            setStage("review")
            setError("")
          }}
        >
          {editing ? "Cancel" : "Back"}
        </Button>
      )}
      <Button
        className="ml-auto"
        disabled={pending || importing || resumeText.trim().length < 100}
      >
        {pending ? "Understanding your experience…" : "Build my profile"}
      </Button>
    </>
  )

  const summary = (
    <div className="space-y-4" aria-label="Your background">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-heading text-lg leading-tight">
            {candidate.fullName || "Name not found"}
          </p>
          <p className="mt-1 text-sm">
            {candidate.headline || "Professional headline not found"}
          </p>
          <p className="mt-1 text-[13px] text-muted-foreground">
            {candidate.currentLocation ?? "Location not provided"} ·{" "}
            {candidate.experienceYears === null
              ? "Experience duration not established"
              : `About ${candidate.experienceYears} years of experience`}
          </p>
        </div>
        {editing && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={replaceResume}
          >
            <RefreshCw aria-hidden="true" />
            Replace resume
          </Button>
        )}
      </div>
      {candidate.skills.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Skills">
          {candidate.skills.map((skill) => (
            <li
              key={skill}
              className="inline-flex h-7 items-center rounded-full border bg-background px-2.5 text-[13px]"
            >
              {skill}
            </li>
          ))}
        </ul>
      )}
      {insights && (
        <>
          <ResumeSections candidate={candidate} />
          <p className="text-xs text-muted-foreground">
            Extracted details link back to your resume. Experience duration is
            an estimate from dated roles; overlapping roles count once. Missing
            information stays unknown.
          </p>
        </>
      )}
    </div>
  )

  const detailFields = (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Full name" id="full-name">
        <Input
          id="full-name"
          {...backgroundIssueProps("full-name")}
          value={candidate.fullName}
          maxLength={120}
          onChange={(e) => update("fullName", e.target.value)}
        />
      </Field>
      <Field label="Professional headline" id="headline">
        <Input
          id="headline"
          {...backgroundIssueProps("headline")}
          value={candidate.headline}
          maxLength={160}
          onChange={(e) => update("headline", e.target.value)}
        />
      </Field>
      <Field label="Current location (optional)" id="location">
        <Input
          id="location"
          value={candidate.currentLocation ?? ""}
          maxLength={120}
          onChange={(e) => update("currentLocation", e.target.value || null)}
        />
      </Field>
      <Field
        label={
          editing
            ? "Years of experience (optional)"
            : "Years of professional experience"
        }
        id="years"
      >
        <Input
          id="years"
          type="number"
          min={0}
          max={60}
          aria-required={editing ? undefined : true}
          aria-invalid={
            showBackgroundIssues && needsExperience ? true : undefined
          }
          aria-describedby={editing ? undefined : "onboarding-experience-help"}
          value={candidate.experienceYears ?? ""}
          onChange={(e) =>
            update(
              "experienceYears",
              e.target.value === "" ? null : Number(e.target.value)
            )
          }
        />
        {!editing && (
          <p
            id="onboarding-experience-help"
            role={showBackgroundIssues && needsExperience ? "alert" : undefined}
            className={cn(
              "text-[13px] text-muted-foreground",
              showBackgroundIssues && needsExperience && "text-destructive"
            )}
          >
            {onboardingExperienceMessage}
          </p>
        )}
      </Field>
      <Field label="Skills, separated by commas" id="skills">
        <Input
          id="skills"
          {...backgroundIssueProps("skills")}
          value={skills}
          onChange={(e) => setSkills(e.target.value)}
        />
      </Field>
      <Field label="Search roles, separated by commas" id="roles">
        <Input
          id="roles"
          {...backgroundIssueProps("roles")}
          value={roles}
          onChange={(e) => setRoles(e.target.value)}
        />
      </Field>
    </div>
  )

  const categories = (
    <JobCategoryFields
      selected={candidate.jobCategories}
      onChange={(value) => update("jobCategories", value)}
      disabled={pending}
    />
  )

  const locations = (
    <fieldset disabled={pending}>
      <LocationPicker
        country={JOB_SEARCH_COUNTRY}
        selected={candidate.targetLocations ?? []}
        onAdd={(place) =>
          setCandidate((current) => ({
            ...current,
            targetLocations: [...(current.targetLocations ?? []), place],
          }))
        }
        onRemove={(id) =>
          setCandidate((current) => ({
            ...current,
            targetLocations: (current.targetLocations ?? []).filter(
              (place) => place.id !== id
            ),
          }))
        }
      />
    </fieldset>
  )

  const preferences = (
    <div className="grid gap-6">
      <p className="text-[13px] text-muted-foreground">
        Resume roles suggest your starting search. Work modes and visa needs are
        your choices; we don’t infer them from your background.
      </p>
      <fieldset>
        <legend className="mb-2.5 text-sm font-medium">Work modes</legend>
        <div className="flex flex-wrap gap-2">
          {(["remote", "hybrid", "onsite"] as const).map((mode) => {
            const active = candidate.workModes.includes(mode)
            return (
              <Chip
                key={mode}
                active={active}
                className="capitalize"
                disabled={pending}
                onClick={() =>
                  update(
                    "workModes",
                    active
                      ? candidate.workModes.filter((m) => m !== mode)
                      : [...candidate.workModes, mode]
                  )
                }
              >
                {active && <Check className="size-3.5" aria-hidden="true" />}
                {mode}
              </Chip>
            )
          })}
        </div>
      </fieldset>
      <fieldset>
        <legend className="mb-2.5 text-sm font-medium">
          Do you need visa sponsorship?
        </legend>
        <div className="flex flex-wrap gap-2">
          {(
            [
              [null, "Not specified"],
              [true, "Yes"],
              [false, "No"],
            ] as const
          ).map(([value, label]) => (
            <Chip
              key={label}
              active={candidate.sponsorshipRequired === value}
              disabled={pending}
              onClick={() => update("sponsorshipRequired", value)}
            >
              {label}
            </Chip>
          ))}
        </div>
      </fieldset>
      {candidate.workModes.includes("remote") && (
        <fieldset>
          <legend className="mb-1 text-sm font-medium">
            Open to working remotely from outside India?
          </legend>
          <p className="mb-2.5 text-[13px] text-muted-foreground">
            Some employers can hire through a local entity or accept contractors
            based outside India.
          </p>
          <div className="flex flex-wrap gap-2">
            {(
              [
                [true, "Yes"],
                [false, "No"],
              ] as const
            ).map(([value, label]) => (
              <Chip
                key={label}
                active={(candidate.remoteFromHome ?? false) === value}
                disabled={pending}
                onClick={() => update("remoteFromHome", value)}
              >
                {label}
              </Chip>
            ))}
          </div>
        </fieldset>
      )}
      <Field
        label="Companies to exclude (optional, separated by commas)"
        id="excluded"
      >
        <Input
          id="excluded"
          value={excluded}
          onChange={(e) => setExcluded(e.target.value)}
        />
      </Field>
    </div>
  )

  const autoApply = candidate.autoApply ?? {
    enabled: false,
    minScore: DEFAULT_AUTO_APPLY_SCORE,
  }
  const autoApplyFields = (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <Label htmlFor="auto-apply" className="flex-col items-start gap-1">
          <span className="text-sm font-medium">Apply automatically</span>
          <span className="text-[13px] font-normal text-muted-foreground">
            New jobs at or above your match score get a tailored PDF resume and
            are sent without a click. Jobs with unanswered employer questions
            wait for you.
          </span>
        </Label>
        <Switch
          id="auto-apply"
          checked={autoApply.enabled}
          disabled={pending}
          onCheckedChange={(enabled) =>
            update("autoApply", { ...autoApply, enabled })
          }
        />
      </div>
      <div className={cn(!autoApply.enabled && "opacity-50")}>
        <div className="mb-2 flex items-baseline justify-between">
          <Label htmlFor="auto-apply-score">Minimum match score</Label>
          <span className="font-mono text-sm tabular-nums">
            {autoApply.minScore}
          </span>
        </div>
        <input
          id="auto-apply-score"
          type="range"
          min={50}
          max={100}
          step={5}
          value={autoApply.minScore}
          disabled={pending || !autoApply.enabled}
          onChange={(e) =>
            update("autoApply", {
              ...autoApply,
              minScore: Number(e.target.value),
            })
          }
          className="w-full accent-primary"
        />
        <p className="mt-2 text-[13px] text-muted-foreground">
          Runs in the background after each job refresh and counts toward your
          plan&apos;s monthly applications. Where you need a visa, only
          employers with a possible-or-better sponsorship signal are included.
        </p>
      </div>
    </div>
  )

  const sourceResume = (
    <details>
      <summary className="cursor-pointer text-sm font-medium text-muted-foreground transition-colors duration-150 ease-out-expo hover:text-foreground">
        View source resume
      </summary>
      <pre className="mt-3 max-h-96 overflow-auto rounded-md bg-muted/50 p-3 font-sans text-[13px] whitespace-pre-wrap">
        {candidate.resumeText}
      </pre>
    </details>
  )

  const applicationProfileFields = (
    <ApplicationProfileFields
      value={candidate.applicationProfile}
      resumeText={candidate.resumeText}
      countries={[JOB_SEARCH_COUNTRY]}
      disabled={pending}
      onboarding={!editing}
      onChange={(applicationProfile) =>
        update("applicationProfile", applicationProfile)
      }
    />
  )

  if (editing)
    return stage === "resume" ? (
      <form
        className="space-y-6"
        onSubmit={(e) => {
          e.preventDefault()
          void analyze()
        }}
      >
        <SettingsSection
          id="resume-section"
          title={candidate.resumeText ? "Replace resume" : "Your resume"}
          description={
            candidate.resumeText
              ? "We’ll refresh your background and suggest roles and categories from the new resume. Your other search preferences are kept."
              : "We read your experience, skills and career history to build your profile."
          }
        >
          {resumeFields}
          <div className="mt-6 flex items-center gap-3">{resumeActions}</div>
        </SettingsSection>
      </form>
    ) : (
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <div className="space-y-6">
          {editing === "profile" ? (
            <>
              <SettingsSection
                id="resume-section"
                title="Resume"
                description="What we extracted from your resume. It drives fit ranking."
              >
                <div className="space-y-5">
                  {summary}
                  {sourceResume}
                </div>
              </SettingsSection>
              <SettingsSection
                id="details-section"
                title="Profile details"
                description="Correct anything we read wrong. Roles and skills shape your matches."
              >
                <div className="space-y-6">
                  {detailFields}
                  {categories}
                </div>
              </SettingsSection>
            </>
          ) : (
            <>
              <SettingsSection
                id="preferences-section"
                title="Search preferences"
                description="Preferred cities, work modes, and sponsorship needs."
              >
                <div className="space-y-6">
                  {categories}
                  {locations}
                  {preferences}
                </div>
              </SettingsSection>
              <SettingsSection
                id="auto-apply-section"
                title="Auto-apply"
                description="Let strong matches apply themselves. Save your preferences to turn it on."
              >
                {autoApplyFields}
              </SettingsSection>
              <SettingsSection
                id="application-profile-section"
                title="Application profile"
                description="Confirm answers once so employers can ask the same question in different ways."
              >
                {applicationProfileFields}
              </SettingsSection>
            </>
          )}
        </div>
        <div className="sticky bottom-0 z-20 -mx-4 flex flex-wrap items-center justify-end gap-4 border-t bg-background/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-10 lg:px-10">
          <div className="mr-auto w-full min-w-0 empty:hidden sm:w-auto">
            {errorMessage}
            {notice && (
              <p role="status" className="text-sm">
                {notice}{" "}
                <Link href="/applications" className="underline">
                  View applications
                </Link>
              </p>
            )}
          </div>
          {editing === "preferences" &&
            candidate.applicationProfile?.enabled && (
              <Button
                type="button"
                variant="outline"
                className="w-full sm:w-auto"
                disabled={pending}
                onClick={() => void save(true)}
              >
                Save and continue waiting applications
              </Button>
            )}
          <Button className="w-full sm:w-auto" disabled={pending}>
            {pending
              ? "Saving…"
              : editing === "profile"
                ? "Save profile"
                : "Save preferences"}
          </Button>
        </div>
      </form>
    )

  const current =
    stage === "resume"
      ? 1
      : step === "background"
        ? 2
        : step === "questions"
          ? 3
          : 4
  const heading = {
    1: {
      title: "Start with your resume",
      description: `For professionals with ${MIN_ONBOARDING_EXPERIENCE_YEARS}+ years of experience. We’ll use your resume to help build your profile.`,
    },
    2: {
      title: "Here’s what we found",
      description:
        "Confirm your work experience and correct any details before you go on.",
    },
    3: {
      title: "Answer once, apply more smoothly",
      description:
        "Job portals often ask for details that aren’t on your resume. Add your answers now so fewer applications need your attention. Unknown answers can stay blank.",
    },
    4: {
      title: "Let applications run for you",
      description:
        "Auto-apply is on by default. Review your minimum match score or turn it off before finishing. You can change this anytime in Preferences.",
    },
  }[current]

  return (
    <div className="mx-auto w-full max-w-xl">
      <StepIndicator current={current} />
      <div
        key={current}
        className="mt-8 animate-in duration-200 ease-out-expo fade-in slide-in-from-bottom-2 motion-reduce:animate-none"
      >
        <header className="mb-6 space-y-1.5">
          <h1 className="font-heading text-[28px] leading-tight">
            {heading.title}
          </h1>
          <p className="text-sm text-muted-foreground">{heading.description}</p>
        </header>
        {stage === "resume" ? (
          <form
            className="rounded-xl border bg-card shadow-xs"
            onSubmit={(e) => {
              e.preventDefault()
              void analyze()
            }}
          >
            <div className="p-5 sm:p-6">{resumeFields}</div>
            <StepFooter>{resumeActions}</StepFooter>
          </form>
        ) : (
          <form
            className="rounded-xl border bg-card shadow-xs"
            onSubmit={(e) => {
              e.preventDefault()
              if (step === "background") continueToQuestions()
              else if (step === "questions") {
                const result = applicationProfileSchema.safeParse(
                  candidate.applicationProfile
                )
                if (!result.success) {
                  setError(
                    result.error.issues[0]?.message ??
                      "Check your application details."
                  )
                  return
                }
                setError("")
                setStep("applications")
              } else void save()
            }}
          >
            {step === "background" ? (
              <div className="space-y-5 p-5 sm:p-6">
                {summary}
                {showBackgroundIssues && needsDetails && (
                  <p
                    id="onboarding-background-error"
                    role="alert"
                    className="text-sm text-destructive"
                  >
                    Check{" "}
                    {new Intl.ListFormat("en").format(
                      backgroundIssues.map((field) => field.label)
                    )}{" "}
                    to continue.
                  </p>
                )}
                <details
                  open={detailsOpen}
                  onToggle={(e) => setDetailsOpen(e.currentTarget.open)}
                  className="border-t pt-4"
                >
                  <summary className="cursor-pointer text-sm font-medium">
                    {needsDetails || needsExperience
                      ? "A few details weren’t clear. Complete these to continue."
                      : "Correct profile details"}
                  </summary>
                  <div className="mt-4">{detailFields}</div>
                </details>
                {categories}
                <details className="border-t pt-4">
                  <summary className="cursor-pointer text-sm font-medium">
                    Search preferences
                  </summary>
                  <div className="mt-5 space-y-6">
                    {locations}
                    {preferences}
                  </div>
                </details>
                {sourceResume}
                {errorMessage}
              </div>
            ) : step === "questions" ? (
              <div className="space-y-6 p-5 sm:p-6">
                {applicationProfileFields}
                {errorMessage}
              </div>
            ) : (
              <div className="space-y-6 p-5 sm:p-6">
                {autoApplyFields}
                <p className="text-sm text-muted-foreground">
                  {autoApply.enabled
                    ? "Confirming starts automatic applications to matching jobs using your resume and saved answers. Required questions we can’t answer will wait for you."
                    : "You’ll choose which jobs to apply to. Your saved answers will still help fill application forms."}
                </p>
                <p className="text-[13px] text-muted-foreground">
                  Company-specific questions may still need your input. Manage
                  reusable answers in Saved answers and update these details in
                  Preferences.
                </p>
                {errorMessage}
              </div>
            )}
            <StepFooter>
              <Button
                type="button"
                variant="ghost"
                disabled={pending}
                onClick={() => {
                  if (step === "background") replaceResume()
                  else {
                    setError("")
                    setStep(
                      step === "applications" ? "questions" : "background"
                    )
                  }
                }}
              >
                <ArrowLeft aria-hidden="true" />
                {step === "background" ? "Replace resume" : "Back"}
              </Button>
              <Button
                className="ml-auto"
                disabled={pending || redirecting}
                aria-busy={pending || redirecting}
              >
                {step === "applications" && (pending || redirecting) && (
                  <LoaderCircle
                    className="animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                )}
                {step !== "applications"
                  ? "Continue"
                  : redirecting
                    ? "Profile ready — finding your matches"
                    : pending
                      ? "Saving…"
                      : autoApply.enabled
                        ? "Confirm and start auto-apply"
                        : "Confirm and find matches"}
                {step !== "applications" && <ArrowRight aria-hidden="true" />}
              </Button>
            </StepFooter>
          </form>
        )}
      </div>
    </div>
  )
}
