import { cn } from "@/lib/utils"

export function Chip({
  active,
  className,
  ...props
}: React.ComponentProps<"button"> & { active?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={cn(
        "inline-flex h-8 min-h-11 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm font-medium text-muted-foreground transition-[background-color,color,border-color,scale] duration-150 ease-out-expo hover:border-foreground/20 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none sm:min-h-0",
        active &&
          "border-primary bg-primary text-primary-foreground hover:border-primary hover:text-primary-foreground",
        className
      )}
      {...props}
    />
  )
}
