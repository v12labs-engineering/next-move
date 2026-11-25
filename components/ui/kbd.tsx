import { cn } from "@/lib/utils"

export function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-[4px] border border-b-2 bg-background px-1 font-mono text-[11px] leading-none font-medium text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}
