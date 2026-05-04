import { Link } from '@tanstack/react-router'
import { ChevronRight, MapPinPen, Star } from 'lucide-react'
import { getDifficultyColor } from '@/lib/geo-utils'
import { makeParkingSlug } from '@/lib/slug'
import type { ParkingLot } from '@/types/parking'

type RankingLot = ParkingLot & {
  contentCounts?: {
    reviews: number
    media: number
    web: number
  }
}

export function RankingSection({
  title,
  description,
  lots,
  className,
}: {
  title: string
  description: string
  lots: RankingLot[]
  className?: string
}) {
  if (lots.length === 0) return null

  const isWide = className?.includes('col-span-2')
  const mid = isWide ? Math.ceil(lots.length / 2) : lots.length
  const col1 = lots.slice(0, mid)
  const col2 = isWide ? lots.slice(mid) : []

  return (
    <section className={`bg-white rounded-xl border overflow-hidden ${className ?? ''}`}>
      <div className="px-4 pt-4 pb-3">
        <h2 className="text-xl font-bold">{title}</h2>
        <p className="mt-1 text-base leading-relaxed text-muted-foreground">{description}</p>
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
  lots: RankingLot[]
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
          className="flex items-center gap-4 px-5 py-4 transition-colors hover:bg-gray-50"
        >
          <span className="w-5 shrink-0 text-right text-sm font-medium text-muted-foreground">
            {startIndex + i + 1}
          </span>
          <div
            className={`size-2.5 rounded-full shrink-0 ${getDifficultyColor(lot.difficulty.score)}`}
          />
          <div className="min-w-0 flex-1">
            <div className="truncate text-base font-semibold">{lot.name}</div>
          </div>
          <LotEvidence lot={lot} />
          <ChevronRight className="size-3.5 text-muted-foreground shrink-0" />
        </Link>
      ))}
    </div>
  )
}

function LotEvidence({ lot }: { lot: RankingLot }) {
  const score = lot.difficulty.score
  const counts = lot.contentCounts
  const totalSources = counts ? counts.reviews + counts.media + counts.web : 0

  return (
    <div className="flex shrink-0 items-center gap-3 text-sm font-semibold text-muted-foreground">
      <span className="flex w-12 items-center gap-1.5">
        <Star className="size-3.5 fill-yellow-400 text-yellow-400 shrink-0" />
        <span className="tabular-nums">{score === null ? '-' : score.toFixed(1)}</span>
      </span>
      <span className="flex w-10 items-center gap-1.5 font-medium">
        {counts && totalSources > 0 && (
          <>
            <MapPinPen className="size-3.5 shrink-0" />
            <span className="tabular-nums">{totalSources}</span>
          </>
        )}
      </span>
    </div>
  )
}
