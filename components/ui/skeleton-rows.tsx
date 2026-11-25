const shimmer =
  "relative overflow-hidden rounded bg-muted before:absolute before:inset-0 before:-translate-x-full before:bg-gradient-to-r before:from-transparent before:via-background/60 before:to-transparent motion-safe:before:animate-[shimmer_1.6s_ease-in-out_infinite]"

export function SkeletonRows({
  count,
  label = "Loading",
}: {
  count: number
  label?: string
}) {
  return (
    <ul
      className="overflow-hidden rounded-lg border bg-card"
      aria-busy="true"
      aria-label={label}
    >
      {Array.from({ length: count }, (_, index) => (
        <li
          key={index}
          className="flex items-center gap-4 border-b px-4 py-4 last:border-b-0"
        >
          <span className={`${shimmer} size-8 shrink-0 rounded-md`} />
          <span className="grid flex-1 gap-2">
            <span className={`${shimmer} h-3.5 w-2/5`} />
            <span className={`${shimmer} h-3 w-3/5 opacity-70`} />
          </span>
          <span className={`${shimmer} hidden h-6 w-20 rounded-md sm:block`} />
        </li>
      ))}
    </ul>
  )
}
