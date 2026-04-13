import { Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { getDifficultyColor, getDifficultyIcon } from '@/lib/geo-utils'
import { makeParkingSlug } from '@/lib/slug'
import type { ParkingLot } from '@/types/parking'

export function RankingSection({
  title,
  description,
  lots,
  className,
}: {
  title: string
  description: string
  lots: ParkingLot[]
  className?: string
}) {
  if (lots.length === 0) return null

  const isWide = className?.includes('col-span-2')
  const mid = isWide ? Math.ceil(lots.length / 2) : lots.length
  const col1 = lots.slice(0, mid)
  const col2 = isWide ? lots.slice(mid) : []

  return (
    <section className={`bg-white rounded-xl border overflow-hidden ${className ?? ''}`}>
      <div className="px-4 pt-4 pb-2">
        <h2 className="font-semibold text-sm">{title}</h2>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </div>
      <div className={isWide ? 'grid grid-cols-1 md:grid-cols-2' : ''}>
        <RankingList lots={col1} startIndex={0} />
        {col2.length > 0 && <RankingList lots={col2} startIndex={mid} className="md:border-l" />}
      </div>
    </section>
  )
}

function RankingList({
  lots,
  startIndex,
  className,
}: {
  lots: ParkingLot[]
  startIndex: number
  className?: string
}) {
  return (
    <div className={`divide-y ${className ?? ''}`}>
      {lots.map((lot, i) => (
        <Link
          key={lot.id}
          to="/wiki/$slug"
          params={{ slug: makeParkingSlug(lot.name, lot.id) }}
          className="flex items-center gap-2.5 px-4 py-2.5 hover:bg-gray-50 transition-colors"
        >
          <span className="text-xs font-medium text-muted-foreground w-4 text-right shrink-0">
            {startIndex + i + 1}
          </span>
          <div
            className={`size-2.5 rounded-full shrink-0 ${getDifficultyColor(lot.difficulty.score)}`}
          />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium truncate">{lot.name}</div>
          </div>
          <span className="shrink-0 text-sm">{getDifficultyIcon(lot.difficulty.score)}</span>
          {lot.totalSpaces > 0 && (
            <span className="shrink-0 text-[11px] text-muted-foreground">{lot.totalSpaces}면</span>
          )}
          <ChevronRight className="size-3.5 text-muted-foreground shrink-0" />
        </Link>
      ))}
    </div>
  )
}
