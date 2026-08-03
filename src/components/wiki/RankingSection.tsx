import { Link } from '@tanstack/react-router'
import { ArrowUpRight, ChevronRight, MapPinPen, Star } from 'lucide-react'
import {
  Carousel,
  CarouselArrows,
  CarouselProvider,
  CarouselSlide,
} from '@/components/parking-reputation/Carousel'
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
      {layout === 'carousel' ? (
        <CarouselProvider>
          <div className="mb-4 flex items-start justify-between gap-2 px-1">
            <div>
              <h2 className="text-xl font-bold">{title}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{description}</p>
            </div>
            <CarouselArrows />
          </div>
          <div className="pb-1">
            <Carousel>
              {visible.map((lot, i) => (
                <CarouselSlide key={lot.id} size="ranking">
                  <RankingCard lot={lot} rank={i + 1} />
                </CarouselSlide>
              ))}
            </Carousel>
          </div>
        </CarouselProvider>
      ) : (
        <>
          <div className="mb-4 px-1">
            <h2 className="text-xl font-bold">{title}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          </div>
          <div
            className={`rounded-2xl bg-white overflow-hidden ${isWide ? 'grid grid-cols-1 md:grid-cols-2' : ''}`}
          >
            <RankingList lots={col1} startIndex={0} />
            {col2.length > 0 && (
              <RankingList
                lots={col2}
                startIndex={mid}
                className="md:border-l md:border-zinc-100"
              />
            )}
          </div>
        </>
      )}
    </section>
  )
}

function RankingCard({ lot }: { lot: RankingLot }) {
  const score = lot.difficulty.score
  const counts = lot.contentCounts

  return (
    <Link
      to="/wiki/$slug"
      params={{ slug: makeParkingSlug(lot.name, lot.id) }}
      className="group flex h-full w-full flex-col gap-1.5 rounded-2xl bg-white p-5 transition-transform duration-200 active:scale-[0.99]"
    >
      <div className="flex items-center gap-2">
        <div
          className={`size-3 shrink-0 rounded-full ${getDifficultyColor(lot.difficulty.score)}`}
        />
        <h3 className="line-clamp-1 text-lg font-bold tracking-tight transition-colors group-hover:text-primary">
          {lot.name}
        </h3>
        <ArrowUpRight className="ml-auto size-4 shrink-0 text-primary opacity-0 transition-opacity group-hover:opacity-100" />
      </div>
      <p className="line-clamp-1 text-sm text-muted-foreground">{lot.address}</p>
      {lot.curationReason && (
        <p className="line-clamp-1 text-sm font-medium text-primary">{lot.curationReason}</p>
      )}

      <div className="mt-auto space-y-2.5 pt-3">
        <div className="flex items-baseline gap-2.5">
          <span className="flex items-center gap-1 text-base font-bold text-zinc-900">
            <Star className="size-4 shrink-0 fill-yellow-400 text-yellow-400" />
            <span className="tabular-nums">{score === null ? '-' : score.toFixed(1)}</span>
          </span>
          {counts && (
            <span className="flex gap-2 text-xs font-medium text-muted-foreground">
              {counts.reviews > 0 && <span className="tabular-nums">리뷰 {counts.reviews}</span>}
              {counts.media > 0 && <span className="tabular-nums">영상 {counts.media}</span>}
              {counts.web > 0 && <span className="tabular-nums">블로그 {counts.web}</span>}
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5 text-xs font-medium text-zinc-600">
          {lot.totalSpaces > 0 && (
            <span className="rounded-md bg-zinc-100 px-2 py-1">{lot.totalSpaces}면</span>
          )}
          <span className="rounded-md bg-zinc-100 px-2 py-1">
            {lot.pricing.isFree ? '무료' : '유료'}
          </span>
        </div>
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
    <div className={`divide-y divide-zinc-100 ${className ?? ''}`}>
      {lots.map((lot, i) => (
        <Link
          key={lot.id}
          to="/wiki/$slug"
          params={{ slug: makeParkingSlug(lot.name, lot.id) }}
          className="flex items-center gap-3 px-4 py-4 transition-colors hover:bg-zinc-50 active:bg-zinc-100"
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
