import { Link } from '@tanstack/react-router'
import { ChevronRight, MapPinPen, Star } from 'lucide-react'
import { Carousel, CarouselSlide } from '@/components/parking-reputation/Carousel'
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

/** 랭킹 섹션(캐러셀·그리드)에서 노출할 최대 주차장 수. */
const MAX_VISIBLE_LOTS = 9

export function RankingSection({
  title,
  description,
  lots,
  className,
  layout = 'grid',
}: {
  title: string
  description: string
  lots: RankingLot[]
  className?: string
  layout?: 'carousel' | 'grid'
}) {
  if (lots.length === 0) return null

  const visible = lots.slice(0, MAX_VISIBLE_LOTS)
  const isWide = className?.includes('col-span-2') || layout === 'carousel'
  const mid = isWide ? Math.ceil(visible.length / 2) : visible.length
  const col1 = visible.slice(0, mid)
  const col2 = isWide ? visible.slice(mid) : []

  return (
    <section className={`flex flex-col ${className ?? ''}`}>
      <div className="mb-4 px-1">
        <h2 className="text-xl font-bold">{title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      {layout === 'carousel' ? (
        <div className="pb-1">
          <Carousel>
            {visible.map((lot, i) => (
              <CarouselSlide key={lot.id} size="ranking">
                <RankingCard lot={lot} rank={i + 1} />
              </CarouselSlide>
            ))}
          </Carousel>
        </div>
      ) : (
        <div
          className={`rounded-xl border bg-white overflow-hidden shadow-xs ${isWide ? 'grid grid-cols-1 md:grid-cols-2' : ''}`}
        >
          <RankingList lots={col1} startIndex={0} />
          {col2.length > 0 && <RankingList lots={col2} startIndex={mid} className="md:border-l" />}
        </div>
      )}
    </section>
  )
}

function RankingCard({ lot }: { lot: RankingLot }) {
  return (
    <Link
      to="/wiki/$slug"
      params={{ slug: makeParkingSlug(lot.name, lot.id) }}
      className="flex h-full w-full flex-col gap-3 rounded-xl border bg-white p-5 shadow-xs transition-colors hover:border-blue-300"
    >
      <div className="flex items-center gap-2">
        <div
          className={`size-3 shrink-0 rounded-full ${getDifficultyColor(lot.difficulty.score)}`}
        />
        <h3 className="line-clamp-1 text-lg font-bold">{lot.name}</h3>
      </div>
      <p className="line-clamp-1 text-sm text-muted-foreground">{lot.address}</p>

      <div className="mt-auto flex items-end justify-between pt-2">
        <div className="flex flex-wrap gap-2 text-xs">
          {lot.totalSpaces > 0 && (
            <span className="rounded-full bg-gray-100 px-2.5 py-1 text-gray-700">
              {lot.totalSpaces}면
            </span>
          )}
          <span className="rounded-full bg-gray-100 px-2.5 py-1 text-gray-700">
            {lot.pricing.isFree ? '무료' : '유료'}
          </span>
        </div>
        <LotEvidenceLarge lot={lot} />
      </div>
    </Link>
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
          className="flex items-center gap-3 px-4 py-4 transition-colors hover:bg-gray-50"
        >
          <span className="w-5 shrink-0 text-right text-sm font-medium text-muted-foreground">
            {startIndex + i + 1}
          </span>
          <div
            className={`size-2.5 shrink-0 rounded-full ${getDifficultyColor(lot.difficulty.score)}`}
          />
          <div className="min-w-0 flex-1">
            <div className="truncate text-base font-semibold">{lot.name}</div>
          </div>
          <LotEvidence lot={lot} />
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
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
    <div className="flex w-[6.5rem] shrink-0 items-center justify-end gap-3 text-sm font-semibold text-muted-foreground">
      <span className="flex w-12 items-center gap-1.5">
        <Star className="size-3.5 shrink-0 fill-yellow-400 text-yellow-400" />
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

function LotEvidenceLarge({ lot }: { lot: RankingLot }) {
  const score = lot.difficulty.score
  const counts = lot.contentCounts
  const totalSources = counts ? counts.reviews + counts.media + counts.web : 0

  return (
    <div className="flex shrink-0 items-center gap-3 text-base font-bold text-zinc-900">
      <span className="flex items-center gap-1.5">
        <Star className="size-4 shrink-0 fill-yellow-400 text-yellow-400" />
        <span className="tabular-nums">{score === null ? '-' : score.toFixed(1)}</span>
      </span>
      {counts && totalSources > 0 && (
        <span className="flex items-center gap-1.5">
          <MapPinPen className="size-4 shrink-0 text-muted-foreground" />
          <span className="tabular-nums text-muted-foreground">{totalSources}</span>
        </span>
      )}
    </div>
  )
}
