"use client"
import { DropdownMenu } from "radix-ui"
import { Check, ChevronDown, PlusCircle, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

type Option<T extends string> = {
  value: T
  label: string
  icon?: React.ComponentType<{ className?: string }>
  hint?: string
}

/** shadcn data-table style single-select filter with a quiet trigger and selected-value badge. */
export function FacetFilter<T extends string>({
  title,
  value,
  allValue,
  options,
  onChange,
}: {
  title: string
  value: T
  allValue: T
  options: Option<T>[]
  onChange: (value: T) => void
}) {
  const selected = options.find((option) => option.value === value)
  const active = value !== allValue && selected
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            "rounded-lg border-border bg-card shadow-none",
            active && "border-primary/40 bg-primary/5 text-primary"
          )}
        >
          <PlusCircle
            className={cn(
              "transition-transform duration-150",
              active && "rotate-45"
            )}
          />
          {title}
          {active && (
            <>
              <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />
              <span className="rounded-sm bg-secondary px-1.5 py-0.5 text-xs font-medium text-secondary-foreground">
                {selected.label}
              </span>
            </>
          )}
          <ChevronDown className="size-3.5 opacity-50" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={6}
          className="z-50 max-h-[var(--radix-dropdown-menu-content-available-height)] min-w-48 animate-in overflow-y-auto overscroll-contain rounded-xl border bg-popover p-1 text-popover-foreground shadow-md duration-150 zoom-in-95 fade-in motion-reduce:animate-none"
        >
          <DropdownMenu.RadioGroup
            value={value}
            onValueChange={(next) => onChange(next as T)}
          >
            {options.map((option) => {
              const Icon = option.icon
              return (
                <DropdownMenu.RadioItem
                  key={option.value}
                  value={option.value}
                  className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground sm:min-h-9"
                >
                  <span className="flex size-4 items-center justify-center">
                    <DropdownMenu.ItemIndicator>
                      <Check className="size-4" />
                    </DropdownMenu.ItemIndicator>
                  </span>
                  {Icon && <Icon className="size-4 text-muted-foreground" />}
                  {option.label}
                  {option.hint && (
                    <span className="ml-auto pl-3 text-xs text-muted-foreground">
                      {option.hint}
                    </span>
                  )}
                </DropdownMenu.RadioItem>
              )
            })}
          </DropdownMenu.RadioGroup>
          {active && (
            <>
              <DropdownMenu.Separator className="-mx-1 my-1 h-px bg-border" />
              <DropdownMenu.Item
                onSelect={() => onChange(allValue)}
                className="flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none data-highlighted:bg-accent sm:min-h-9"
              >
                <X className="size-3.5" />
                Clear filter
              </DropdownMenu.Item>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

/** On/off filter matching FacetFilter's trigger. */
export function ToggleFilter({
  pressed,
  onPressedChange,
  icon: Icon,
  children,
}: {
  pressed: boolean
  onPressedChange: (pressed: boolean) => void
  icon: React.ComponentType<{ className?: string }>
  children: React.ReactNode
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      aria-pressed={pressed}
      onClick={() => onPressedChange(!pressed)}
      className={cn(
        "rounded-lg border-border bg-card shadow-none",
        pressed &&
          "border-solid border-primary/40 bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary"
      )}
    >
      <Icon />
      {children}
    </Button>
  )
}
