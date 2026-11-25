import { cn } from "@/lib/utils"

/** Chess board where one square has become a cypress spire: the next move. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={cn("size-4", className)}
    >
      <rect x="2" y="12.5" width="9.5" height="9.5" rx="1" />
      <rect x="2" y="2" width="9.5" height="9.5" rx="1" opacity="0.32" />
      <rect x="12.5" y="12.5" width="9.5" height="9.5" rx="1" opacity="0.32" />
      <path d="M17.25 1.5c2.5 2.6 3.9 6 3.9 9.5h-7.8c0-3.5 1.4-6.9 3.9-9.5Z" />
    </svg>
  )
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <span className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground shadow-key">
        <LogoMark />
      </span>
      <span className="font-heading text-base font-semibold tracking-tight">
        next move
        <span
          aria-hidden="true"
          className="ml-0.5 inline-block h-[1.05em] w-[0.12em] translate-y-[0.18em] rounded-[1px] bg-primary motion-safe:animate-caret"
        />
      </span>
    </span>
  )
}
