"use client"
import { useEffect, useState } from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { useTheme } from "next-themes"
import {
  Briefcase,
  FileCheck2,
  Inbox,
  LogOut,
  Moon,
  Search,
  Sun,
  SlidersHorizontal,
  UserRound,
} from "lucide-react"
import { Logo } from "@/components/shell/logo"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { CommandMenu } from "@/components/shell/command-menu"
import { useNavCounts, type NavCounts } from "@/lib/nav-counts"
import { cn } from "@/lib/utils"
import { ApplicationQuestionAlerts } from "@/components/applications/application-question-alerts"

type NavItem = {
  href: string
  label: string
  icon: typeof Briefcase
  key: string
  also?: string[]
  count?: keyof NavCounts
  countLabel?: string
}

const navItems: NavItem[] = [
  {
    href: "/jobs",
    label: "Jobs",
    icon: Briefcase,
    key: "j",
    count: "jobs",
    countLabel: "to review",
  },
  {
    href: "/inbox",
    label: "Inbox",
    icon: Inbox,
    key: "i",
    count: "applications",
    countLabel: "need you",
  },
  {
    href: "/applications",
    label: "Applications",
    icon: FileCheck2,
    key: "a",
    also: ["/resumes"],
  },
  { href: "/profile", label: "Profile", icon: UserRound, key: "p" },
  {
    href: "/preferences",
    label: "Preferences",
    icon: SlidersHorizontal,
    key: "s",
  },
]

export function isTypingTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) ||
      !!target.closest('[role="combobox"], [role="listbox"]'))
  )
}

/** "g" then a nav key jumps between sections, Linear-style. */
function useGoToShortcuts() {
  const router = useRouter()
  useEffect(() => {
    let armed = 0
    function onKey(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (isTypingTarget(event.target)) return
      const key = event.key.toLowerCase()
      if (Date.now() - armed < 900) {
        armed = 0
        const item = navItems.find((nav) => nav.key === key)
        if (item) {
          event.preventDefault()
          router.push(item.href)
        }
        return
      }
      if (key === "g") armed = Date.now()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [router])
}

function NavLinks({
  pathname,
  mobile,
  items = navItems,
}: {
  pathname: string
  mobile?: boolean
  items?: NavItem[]
}) {
  const counts = useNavCounts()
  return items.map((item) => {
    const Icon = item.icon
    const active = [item.href, ...(item.also ?? [])].some(
      (href) => pathname === href || pathname.startsWith(`${href}/`)
    )
    const count = item.count ? counts[item.count] : undefined
    return (
      <Link
        key={item.href}
        href={item.href}
        aria-current={active ? "page" : undefined}
        aria-keyshortcuts={`g ${item.key}`}
        className={cn(
          "group relative flex rounded-lg font-medium transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring",
          mobile
            ? "min-h-14 min-w-0 flex-col justify-center gap-1 px-0.5 py-2 text-[10px] leading-4 tracking-tight text-muted-foreground hover:bg-muted hover:text-foreground sm:text-[11px]"
            : "h-10 items-center gap-3 px-3 text-[13px] text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground focus-visible:ring-sidebar-ring",
          active &&
            (mobile
              ? "bg-accent text-accent-foreground"
              : "bg-sidebar-accent text-sidebar-accent-foreground")
        )}
      >
        <Icon
          className={cn(
            "size-4",
            active && (mobile ? "text-primary" : "text-sidebar-primary")
          )}
        />
        <span
          className={
            mobile ? "max-w-full text-center whitespace-nowrap" : undefined
          }
        >
          {item.label}
        </span>
        {Boolean(count) && (
          <span
            aria-label={`${count} ${item.countLabel}`}
            className={cn(
              "min-w-5 rounded-full px-1.5 text-center font-semibold tabular-nums",
              mobile
                ? "absolute top-1 right-1 text-[9px] leading-4"
                : "ml-auto text-[11px] leading-5",
              !mobile && "group-hover:hidden group-focus-visible:hidden",
              item.count === "applications"
                ? "bg-primary text-primary-foreground"
                : mobile
                  ? "bg-muted text-muted-foreground"
                  : "bg-sidebar-accent text-sidebar-foreground/80"
            )}
          >
            {count}
          </span>
        )}
        {!mobile && (
          <span className="ml-auto hidden gap-0.5 group-hover:flex group-focus-visible:flex">
            <Kbd className="border-sidebar-border bg-sidebar text-sidebar-foreground/60">
              G
            </Kbd>
            <Kbd className="border-sidebar-border bg-sidebar text-sidebar-foreground/60">
              {item.key.toUpperCase()}
            </Kbd>
          </span>
        )}
      </Link>
    )
  })
}

function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme()
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label="Toggle light and dark theme"
      className={className}
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
    >
      <Sun className="hidden dark:block" />
      <Moon className="dark:hidden" />
    </Button>
  )
}

function Brand() {
  return (
    <Link href="/jobs">
      <Logo />
    </Link>
  )
}

/** Shared workspace shell with a desktop sidebar and five visible mobile destinations. */
export function AppShell({
  title,
  description,
  actions,
  children,
}: {
  title: string
  description?: React.ReactNode
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  const pathname = usePathname()
  const [commandOpen, setCommandOpen] = useState(false)
  useGoToShortcuts()
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        setCommandOpen((open) => !open)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])
  return (
    <div className="min-h-svh bg-background lg:grid lg:grid-cols-[240px_1fr]">
      <aside className="hidden border-r border-sidebar-border bg-sidebar text-sidebar-foreground lg:sticky lg:top-0 lg:flex lg:h-svh lg:flex-col">
        <div className="px-5 pt-5 pb-4">
          <Brand />
        </div>
        <div className="px-3 pb-3">
          <button
            type="button"
            onClick={() => setCommandOpen(true)}
            aria-keyshortcuts="Meta+K"
            className="flex h-10 w-full items-center gap-2.5 rounded-lg border border-sidebar-border bg-sidebar-accent/30 px-3 text-[13px] text-sidebar-foreground/65 transition-colors duration-150 hover:bg-sidebar-accent/70 hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none"
          >
            <Search className="size-4" />
            Search
            <span className="ml-auto flex gap-0.5">
              <Kbd className="border-sidebar-border bg-sidebar text-sidebar-foreground/60">
                ⌘
              </Kbd>
              <Kbd className="border-sidebar-border bg-sidebar text-sidebar-foreground/60">
                K
              </Kbd>
            </span>
          </button>
        </div>
        <nav className="grid gap-1 px-3" aria-label="Main">
          <NavLinks pathname={pathname} />
        </nav>
        <div className="mt-auto grid gap-1 border-t border-sidebar-border p-3">
          <div className="flex items-center gap-1">
            <form action="/auth/sign-out" method="post" className="flex-1">
              <Button
                type="submit"
                variant="ghost"
                size="sm"
                className="w-full justify-start gap-2.5 px-3 text-sidebar-foreground/65 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
              >
                <LogOut className="size-4" />
                Sign out
              </Button>
            </form>
            <ThemeToggle className="text-sidebar-foreground/65 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground" />
          </div>
        </div>
      </aside>

      <header className="sticky top-0 z-30 border-b bg-background/90 backdrop-blur lg:hidden">
        <div className="flex items-center justify-between px-4 py-3">
          <Brand />
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Search"
              onClick={() => setCommandOpen(true)}
            >
              <Search />
            </Button>
            <ThemeToggle />
            <form action="/auth/sign-out" method="post">
              <Button
                type="submit"
                variant="ghost"
                size="icon-sm"
                aria-label="Sign out"
              >
                <LogOut />
              </Button>
            </form>
          </div>
        </div>
        <nav className="grid grid-cols-5 gap-1 px-3 pb-2" aria-label="Main">
          <NavLinks pathname={pathname} mobile />
        </nav>
      </header>

      <main className="min-w-0">
        <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-10 lg:py-10">
          <header className="mb-6 flex flex-wrap items-start justify-between gap-x-6 gap-y-4 lg:mb-8">
            <div className="min-w-0 space-y-1.5">
              <h1 className="font-heading text-2xl leading-tight sm:text-[30px]">
                {title}
              </h1>
              {description && (
                <p className="max-w-[65ch] text-sm leading-relaxed text-muted-foreground">
                  {description}
                </p>
              )}
            </div>
            {actions && (
              <div className="flex flex-wrap items-center gap-2">{actions}</div>
            )}
          </header>
          <div className="space-y-6">
            <ApplicationQuestionAlerts pathname={pathname} />
            {children}
          </div>
        </div>
      </main>
      {commandOpen && <CommandMenu onOpenChange={setCommandOpen} />}
    </div>
  )
}
