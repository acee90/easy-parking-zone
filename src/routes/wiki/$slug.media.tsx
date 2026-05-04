import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import {
  ChevronLeft,
  Clock,
  CreditCard,
  ExternalLink,
  MapPin,
  ParkingSquare,
  Phone,
  Play,
  Star,
} from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { ParkingActionGroup } from '@/components/ParkingActionGroup'
import { StarRatingInput } from '@/components/parking-reputation/StarRatingInput'
import { decodeHtmlEntities } from '@/components/parking-reputation/utils'
import { ReportButton } from '@/components/ReportDialog'
import { Badge } from '@/components/ui/badge'
import { authClient } from '@/lib/auth-client'
import {
  formatOperatingHours,
  formatPhone,
  formatPricing,
  formatTotalSpaces,
} from '@/lib/parking-display'
import { makeParkingSlug, parseIdFromSlug } from '@/lib/slug'
import { fetchParkingDetail, fetchParkingMedia } from '@/server/parking'
import { createReview } from '@/server/reviews'
import type { ParkingLot, ParkingMedia } from '@/types/parking'

export const Route = createFileRoute('/wiki/$slug/media')({
  loader: async ({ params }) => {
    const id = parseIdFromSlug(params.slug)
    if (!id) throw notFound()
    const [lot, media] = await Promise.all([
      fetchParkingDetail({ data: { id } }),
      fetchParkingMedia({ data: { parkingLotId: id, limit: 100 } }),
    ])
    if (!lot) throw notFound()
    return { lot, media }
  },
  head: ({ loaderData }) => {
    const lot = loaderData?.lot
    if (!lot) return {}
    const slug = makeParkingSlug(lot.name, lot.id)
    return {
      meta: [
        { title: `${lot.name} 영상 | 쉬운주차장` },
        { name: 'robots', content: 'noindex, follow' },
      ],
      links: [{ rel: 'canonical', href: `https://easy-parking.xyz/wiki/${slug}` }],
    }
  },
  component: MediaListPage,
})

function MediaListPage() {
  const { lot, media } = Route.useLoaderData()
  const slug = makeParkingSlug(lot.name, lot.id)
  const operatingHours = formatOperatingHours(lot.operatingHours)
  const pricing = formatPricing(lot.pricing)
  const totalSpacesLabel = formatTotalSpaces(lot.totalSpaces)
  const phoneLabel = formatPhone(lot.phone)

  return (
    <div className="min-h-screen bg-white">
      <main className="mx-auto grid max-w-6xl grid-cols-1 gap-6 px-4 py-6 md:grid-cols-[minmax(260px,0.85fr)_minmax(0,2fr)]">
        <ParkingInfoPanel
          lot={lot}
          operatingHours={operatingHours}
          phoneLabel={phoneLabel}
          pricing={pricing}
          slug={slug}
          totalSpacesLabel={totalSpacesLabel}
        />

        <section className="min-w-0">
          <div className="mb-5">
            <h1 className="flex items-baseline gap-2 text-3xl font-bold leading-tight tracking-normal text-zinc-900">
              관련 영상
              <span className="text-base font-semibold text-muted-foreground">
                {media.length}건
              </span>
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">{lot.name}</p>
          </div>

          {media.length > 0 ? (
            <div className="divide-y rounded-xl border bg-white">
              {media.map((item) => (
                <MediaListItem key={item.id} media={item} lotId={lot.id} />
              ))}
            </div>
          ) : (
            <div className="flex min-h-72 flex-col items-center justify-center rounded-xl border bg-white px-6 text-center">
              <div className="mb-4 flex size-14 items-center justify-center rounded-full bg-zinc-100">
                <Play className="size-7 text-zinc-300" />
              </div>
              <p className="text-base font-bold text-zinc-900">관련 영상이 없습니다</p>
              <p className="mt-1 text-sm text-zinc-500">
                이 주차장에 대한 영상 정보를 아직 찾지 못했습니다.
              </p>
            </div>
          )}
        </section>
      </main>
    </div>
  )
}

type InfoPanelProps = {
  lot: ParkingLot
  operatingHours: ReturnType<typeof formatOperatingHours>
  pricing: ReturnType<typeof formatPricing>
  slug: string
  totalSpacesLabel: string | null
  phoneLabel: string | null
}

function ParkingInfoPanel({
  lot,
  operatingHours,
  phoneLabel,
  pricing,
  slug,
  totalSpacesLabel,
}: InfoPanelProps) {
  return (
    <aside className="space-y-4 md:sticky md:top-6 md:self-start">
      <section className="rounded-xl border bg-white p-5">
        <Link
          to="/wiki/$slug"
          params={{ slug }}
          className="mb-4 inline-flex items-center gap-1 text-xs font-semibold text-muted-foreground transition-colors hover:text-zinc-900"
        >
          <ChevronLeft className="size-4" />
          상세로 돌아가기
        </Link>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Badge variant={lot.pricing.isFree ? 'default' : 'outline'}>
            {lot.pricing.isFree ? '무료' : '유료'}
          </Badge>
          <Badge variant="outline">{lot.type}</Badge>
        </div>
        <h2 className="text-lg font-bold leading-snug tracking-normal text-zinc-900">{lot.name}</h2>
        <div className="mt-3 grid grid-cols-[20px_minmax(0,1fr)] gap-2 text-sm text-muted-foreground">
          <MapPin className="mt-0.5 size-4 justify-self-center" />
          <span className="min-w-0">{lot.address}</span>
        </div>
        <div className="mt-4">
          <ParkingActionGroup lotId={lot.id} lat={lot.lat} lng={lot.lng} name={lot.name} />
        </div>
      </section>

      <section className="rounded-xl border bg-white p-5">
        <h2 className="mb-4 text-base font-bold text-zinc-900">주차장 기본정보</h2>
        <div className="space-y-3 text-sm">
          <InfoRow icon={<Clock className="size-4" />}>
            <div className={operatingHours.isUnknown ? 'text-muted-foreground' : ''}>
              {operatingHours.primary}
            </div>
            {operatingHours.secondary && (
              <div className="text-xs text-muted-foreground">{operatingHours.secondary}</div>
            )}
          </InfoRow>

          <InfoRow icon={<CreditCard className="size-4" />}>
            <div className={pricing.isUnknown ? 'text-muted-foreground' : ''}>
              {pricing.primary}
            </div>
            {pricing.secondary && (
              <div className="text-xs text-muted-foreground">{pricing.secondary}</div>
            )}
          </InfoRow>

          {totalSpacesLabel && (
            <InfoRow icon={<ParkingSquare className="size-4" />}>{totalSpacesLabel}</InfoRow>
          )}

          {phoneLabel && (
            <a
              href={`tel:${phoneLabel}`}
              className="inline-flex h-9 w-full min-w-0 items-center justify-center gap-2 rounded-full bg-gray-100 px-3 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-200"
            >
              <Phone className="size-4 shrink-0" />
              <span className="min-w-0 truncate">{phoneLabel}</span>
            </a>
          )}
        </div>
      </section>

      <MiniReviewForm lotId={lot.id} />
    </aside>
  )
}

function InfoRow({ children, icon }: { children: ReactNode; icon: ReactNode }) {
  return (
    <div className="grid grid-cols-[20px_minmax(0,1fr)] gap-2">
      <div className="mt-0.5 flex justify-center text-muted-foreground">{icon}</div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

function MiniReviewForm({ lotId }: { lotId: string }) {
  const { data: session } = authClient.useSession()
  const [score, setScore] = useState(0)
  const [comment, setComment] = useState('')
  const [guestNickname, setGuestNickname] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const hasScore = score >= 0.5

  const handleSubmit = async () => {
    if (!hasScore || submitting) return
    setSubmitting(true)
    setError(null)
    setMessage(null)

    try {
      await createReview({
        data: {
          parkingLotId: lotId,
          entryScore: score,
          spaceScore: score,
          passageScore: score,
          exitScore: score,
          overallScore: score,
          comment: comment || undefined,
          guestNickname: session ? undefined : guestNickname || undefined,
        },
      })
      setScore(0)
      setComment('')
      setGuestNickname('')
      setMessage('평가가 등록되었습니다.')
    } catch (e) {
      setError(e instanceof Error ? e.message : '오류가 발생했습니다')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="rounded-xl border border-yellow-100 bg-yellow-50/50 p-4">
      <div className="flex flex-col items-center gap-2 text-center">
        <p className="flex items-center gap-1.5 text-sm font-semibold text-zinc-900">
          <Star className="size-4 text-yellow-500" />
          주차하기 쉬웠나요?
        </p>
        <StarRatingInput value={score} onChange={setScore} size="md" />
      </div>

      {hasScore && (
        <div className="mt-4 space-y-3 border-t border-yellow-100 pt-4">
          {!session && (
            <input
              type="text"
              value={guestNickname}
              onChange={(e) => setGuestNickname(e.target.value)}
              placeholder="닉네임 (선택)"
              maxLength={20}
              className="h-9 w-full rounded-md border bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-300"
            />
          )}

          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            maxLength={200}
            rows={3}
            placeholder="진입로, 주차면, 통로 여유를 짧게 남겨주세요"
            className="w-full resize-none rounded-md border bg-white px-3 py-2 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-yellow-300"
          />

          {error && <p className="text-xs text-red-500">{error}</p>}
          {message && <p className="text-xs text-green-700">{message}</p>}

          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className="h-9 w-full cursor-pointer rounded-md bg-yellow-500 text-sm font-semibold text-white transition-colors hover:bg-yellow-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? '등록 중...' : '평가 등록'}
          </button>
        </div>
      )}
    </section>
  )
}

function MediaListItem({ media, lotId }: { media: ParkingMedia; lotId: string }) {
  const title = media.title ? decodeHtmlEntities(media.title) : '제목 없음'
  const description = media.description ? decodeHtmlEntities(media.description) : ''

  return (
    <article className="group relative flex flex-col gap-3 p-3 transition-colors hover:bg-zinc-50 sm:flex-row sm:p-4">
      <a
        href={media.url}
        target="_blank"
        rel="noopener noreferrer"
        className="relative aspect-video w-full shrink-0 overflow-hidden rounded-lg bg-zinc-100 sm:w-44"
        aria-label={`${title} 영상 열기`}
      >
        {media.thumbnailUrl ? (
          <img
            src={media.thumbnailUrl}
            alt=""
            className="h-full w-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <Play className="size-9 text-zinc-300" />
          </div>
        )}
        <div className="absolute inset-0 flex items-center justify-center bg-black/10 opacity-0 transition-opacity group-hover:opacity-100">
          <div className="flex size-10 items-center justify-center rounded-full bg-red-600 text-white shadow-sm">
            <Play className="ml-0.5 size-5 fill-current" />
          </div>
        </div>
      </a>

      <div className="flex min-w-0 flex-1 flex-col justify-between gap-3">
        <a href={media.url} target="_blank" rel="noopener noreferrer" className="min-w-0">
          <p className="line-clamp-2 text-base font-bold leading-snug text-zinc-900">{title}</p>
          {description && (
            <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-muted-foreground">
              {description}
            </p>
          )}
        </a>
        <div className="flex items-center justify-end gap-1">
          <ReportButton targetType="media" targetId={media.id} parkingLotId={lotId} />
          <a
            href={media.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-zinc-100 hover:text-zinc-900"
            aria-label="영상 새 창에서 열기"
          >
            <ExternalLink className="size-4" />
          </a>
        </div>
      </div>
    </article>
  )
}
