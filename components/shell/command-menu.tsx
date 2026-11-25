"use client"
import { useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { useTheme } from "next-themes"
import { Dialog } from "radix-ui"
import {
  ArrowUpRight,
  Briefcase,
  CornerDownLeft,
  FileCheck2,
  FileText,
  LogOut,
  Search,
  SunMoon,
  SlidersHorizontal,
  UserRound,
  Inbox,
} from "lucide-react"

import type { Job } from "@/lib/jobs"
import { Kbd } from "@/components/ui/kbd"
import { VisaSignal } from "@/components/jobs/visa-signal"
import { cn, webUrl } from "@/lib/utils"

type Command = {
  id: string
  group: "Go to" | "Actions" | "Jobs"
  label: string
  hint?: string
  icon?: typeof Search
  job?: Job
  keywords?: string
  run: () => void
}

let cachedJobs: Job[] | null = null

/** Lets the Jobs page hand over its already-loaded list so search is instant. */
export function primeCommandJobs(jobs: Job[]) {
  cachedJobs = jobs
}

/** Mounted only while open, so every open starts with a fresh query. */
export function CommandMenu({
  onOpenChange,
}: {
  onOpenChange: (open: boolean) => void
}) {
  const router = useRouter()
  const { resolvedTheme, setTheme } = useTheme()
  const [query, setQuery] = useState("")
  const [jobs, setJobs] = useState<Job[]>(cachedJobs ?? [])
  const [loadingJobs, setLoadingJobs] = useState(!cachedJobs)
  const [activeIndex, setActiveIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ view: "all", limit: "200", query })
      fetch(`/api/state?${params}`, { signal: controller.signal })
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { state?: { jobs: Job[] } } | null) => {
          if (data?.state && !controller.signal.aborted) {
            setJobs(data.state.jobs)
          }
        })
        .catch(() => {})
        .finally(() => {
          if (!controller.signal.aborted) setLoadingJobs(false)
        })
    }, 200)
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [query])

  const commands = useMemo<Command[]>(() => {
    const go = (href: string) => () => router.push(href)
    const base: Command[] = [
      {
        id: "go-jobs",
        group: "Go to",
        label: "Jobs",
        hint: "G J",
        icon: Briefcase,
        run: go("/jobs"),
      },
      {
        id: "go-inbox",
        group: "Go to",
        label: "Inbox",
        hint: "G I",
        icon: Inbox,
        run: go("/inbox"),
      },
      {
        id: "go-applications",
        group: "Go to",
        label: "Applications",
        hint: "G A",
        icon: FileCheck2,
        run: go("/applications"),
      },
      {
        id: "go-drafts",
        group: "Go to",
        label: "Resume drafts",
        icon: FileText,
        keywords: "resumes cv",
        run: go("/applications?view=drafts"),
      },
      {
        id: "go-profile",
        group: "Go to",
        label: "Profile",
        hint: "G P",
        icon: UserRound,
        keywords: "resume background skills",
        run: go("/profile"),
      },
      {
        id: "go-preferences",
        group: "Go to",
        label: "Preferences",
        hint: "G S",
        icon: SlidersHorizontal,
        keywords: "settings cities locations auto-apply visa work modes",
        run: go("/preferences"),
      },
      {
        id: "theme",
        group: "Actions",
        label:
          resolvedTheme === "dark"
            ? "Switch to light theme"
            : "Switch to dark theme",
        icon: SunMoon,
        keywords: "theme dark light mode",
        run: () => setTheme(resolvedTheme === "dark" ? "light" : "dark"),
      },
      {
        id: "sign-out",
        group: "Actions",
        label: "Sign out",
        icon: LogOut,
        keywords: "log out logout",
        run: () => {
          const form = document.createElement("form")
          form.method = "post"
          form.action = "/auth/sign-out"
          document.body.append(form)
          form.submit()
        },
      },
    ]
    const q = query.trim().toLowerCase()
    const matches = (text: string) => text.toLowerCase().includes(q)
    const filtered = q
      ? base.filter((c) => matches(`${c.label} ${c.keywords ?? ""}`))
      : base
    if (!q) return filtered
    const jobCommands = jobs
      .filter((job) => job.status !== "dismissed")
      .filter((job) =>
        matches(`${job.title} ${job.company} ${job.city ?? ""} ${job.country}`)
      )
      .slice(0, 8)
      .map<Command>((job) => ({
        id: `job-${job.id}`,
        group: "Jobs",
        label: job.title,
        job,
        run: () => {
          const url = webUrl(job.url)
          if (url) window.open(url, "_blank", "noreferrer")
        },
      }))
    return [...jobCommands, ...filtered]
  }, [jobs, query, resolvedTheme, router, setTheme])

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" })
  }, [activeIndex])

  function runAt(index: number) {
    const command = commands[index]
    if (!command) return
    onOpenChange(false)
    command.run()
  }

  return (
    <Dialog.Root open onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-foreground/25 backdrop-blur-[2px] data-[state=closed]:animate-out data-[state=closed]:fade-out data-[state=open]:animate-in data-[state=open]:fade-in" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-[14vh] left-1/2 z-50 w-[min(640px,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-2xl duration-200 ease-out-expo data-[state=closed]:animate-out data-[state=closed]:fade-out data-[state=closed]:zoom-out-[0.98] data-[state=open]:animate-in data-[state=open]:fade-in data-[state=open]:zoom-in-[0.98]"
        >
          <Dialog.Title className="sr-only">Command menu</Dialog.Title>
          <div className="flex items-center gap-3 border-b px-4">
            <Search className="size-4 text-muted-foreground" />
            <input
              autoFocus
              role="combobox"
              aria-expanded
              aria-controls="command-list"
              aria-activedescendant={
                commands[activeIndex]
                  ? `command-${commands[activeIndex].id}`
                  : undefined
              }
              placeholder="Search jobs, pages and actions…"
              className="h-13 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setActiveIndex(0)
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault()
                  setActiveIndex((i) => Math.min(commands.length - 1, i + 1))
                } else if (event.key === "ArrowUp") {
                  event.preventDefault()
                  setActiveIndex((i) => Math.max(0, i - 1))
                } else if (event.key === "Enter") {
                  event.preventDefault()
                  runAt(activeIndex)
                }
              }}
            />
            <Kbd>Esc</Kbd>
          </div>

          <div
            ref={listRef}
            id="command-list"
            role="listbox"
            aria-label="Results"
            className="max-h-[min(420px,60vh)] overflow-y-auto p-2"
          >
            {commands.length === 0 && (
              <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                {loadingJobs
                  ? "Loading your jobs…"
                  : `No results for “${query}”`}
              </p>
            )}
            {commands.map((command, index) => {
              const heading =
                commands[index - 1]?.group !== command.group
                  ? command.group
                  : null
              const Icon = command.icon
              const active = index === activeIndex
              return (
                <div key={command.id}>
                  {heading && (
                    <p className="px-3 pt-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                      {heading}
                    </p>
                  )}
                  <div
                    id={`command-${command.id}`}
                    role="option"
                    aria-selected={active}
                    data-index={index}
                    onMouseMove={() => setActiveIndex(index)}
                    onClick={() => runAt(index)}
                    className={cn(
                      "flex h-10 cursor-pointer items-center gap-3 rounded-md px-3 text-sm",
                      active && "bg-accent text-accent-foreground"
                    )}
                  >
                    {command.job ? (
                      <>
                        <VisaSignal
                          value={command.job.visaSignal}
                          className="w-24 shrink-0"
                        />
                        <span className="min-w-0 flex-1 truncate">
                          <span className="font-medium">{command.label}</span>
                          <span className="text-muted-foreground">
                            {" · "}
                            {command.job.company} · {command.job.country}
                          </span>
                        </span>
                        <ArrowUpRight className="size-4 shrink-0 text-muted-foreground" />
                      </>
                    ) : (
                      <>
                        {Icon && (
                          <Icon className="size-4 text-muted-foreground" />
                        )}
                        <span className="flex-1">{command.label}</span>
                        {command.hint && (
                          <span className="flex gap-0.5">
                            {command.hint.split(" ").map((key) => (
                              <Kbd key={key}>{key}</Kbd>
                            ))}
                          </span>
                        )}
                      </>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          <div className="flex items-center justify-between border-t bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> navigate
            </span>
            <span className="flex items-center gap-1.5">
              <Kbd>
                <CornerDownLeft className="size-3" />
              </Kbd>
              open
            </span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
