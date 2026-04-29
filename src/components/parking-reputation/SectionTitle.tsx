export function SectionTitle({ title, count }: { title: string; count: number }) {
  return (
    <h3 className="mb-4 flex items-baseline gap-2 text-xl font-bold tracking-normal text-zinc-950">
      {title}
      {count > 0 && <span className="text-base font-normal text-muted-foreground">({count})</span>}
    </h3>
  )
}
