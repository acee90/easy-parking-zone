import { createFileRoute, Link } from '@tanstack/react-router'
import { ChevronRight, ExternalLink, Info, MapPin, Navigation } from 'lucide-react'
import { getDifficultyColor, getDifficultyIcon } from '@/lib/geo-utils'
import { findRegion } from '@/lib/regions'
import { makeParkingSlug } from '@/lib/slug'
import { fetchGuideDetail } from '@/server/parking'
import spotsData from '../../../../scripts/data/halfprice-travel-spots-geocoded.json'

export const Route = createFileRoute('/event/halfprice-travel/$slug')({
  loader: ({ params }) => fetchGuideDetail({ data: { slug: params.slug } }),
  head: ({ params }) => {
    const region = findRegion(params.slug)
    const name = region?.name ?? params.slug
    return {
      meta: [
        { title: `${name} 반값여행 주차 가이드 | 쉽주` },
        {
          name: 'description',
          content: `${name} 관광지별 주변 주차장 정보. 난이도와 요금까지 한눈에 확인하고 여행 준비를 마치세요.`,
        },
        { property: 'og:title', content: `${name} 반값여행 주차 가이드 | 쉽주` },
        {
          property: 'og:description',
          content: `${name} 관광지별 주변 주차장 정보. 난이도와 요금까지 한눈에 확인하고 여행 준비를 마치세요.`,
        },
        { property: 'og:type', content: 'article' },
        {
          property: 'og:url',
          content: `https://easy-parking.xyz/event/halfprice-travel/${params.slug}`,
        },
        { property: 'og:image', content: 'https://easy-parking.xyz/og-image.png' },
        { property: 'og:site_name', content: '쉽주' },
        { name: 'twitter:card', content: 'summary_large_image' },
        { name: 'twitter:title', content: `${name} 반값여행 주차 가이드 | 쉽주` },
        {
          name: 'twitter:description',
          content: `${name} 관광지별 주변 주차장 정보. 난이도와 요금까지 한눈에 확인하고 여행 준비를 마치세요.`,
        },
        { name: 'twitter:image', content: 'https://easy-parking.xyz/og-image.png' },
      ],
    }
  },
  component: RegionDetailPage,
})

interface SpotParking {
  id: string
  name: string
  address: string
  distanceM: number
  isFree: boolean
  totalSpaces: number
  finalScore: number | null
}

interface Spot {
  name: string
  description: string
  longDescription?: string
  tips?: string[]
  lat: number | null
  lng: number | null
  address?: string | null
  imageUrl?: string | null
  nearbyParking: SpotParking[]
}

function RegionDetailPage() {
  const data = Route.useLoaderData()
  const { slug } = Route.useParams()
  const region = findRegion(slug)

  if (!data || !region) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <p className="text-muted-foreground">가이드를 찾을 수 없습니다.</p>
      </div>
    )
  }

  const regionSpots = spotsData.find((r) => r.region === region.name)
  const spots = (regionSpots?.spots ?? []) as Spot[]

  return (
    <div className="min-h-screen bg-gray-50">
      {/* 브레드크럼 */}
      <div className="bg-white border-b">
        <div className="max-w-3xl mx-auto px-4 py-2 text-xs text-muted-foreground flex items-center gap-1">
          <Link to="/event/halfprice-travel" className="hover:text-foreground transition-colors">
            반값여행
          </Link>
          <ChevronRight className="size-3" />
          <span className="text-foreground">{region.name}</span>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
        {/* 헤더 */}
        <header>
          <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
            <span className="bg-blue-600 text-white px-2 py-0.5 rounded-full text-xs font-bold">
              반값여행
            </span>
            <span>{region.province}</span>
          </div>
          <h1 className="text-xl font-bold">{region.name} 여행 가이드</h1>
          <p className="text-sm text-muted-foreground mt-1">
            주차장 {data.summary.total.toLocaleString()}개 · 무료{' '}
            {data.summary.total > 0
              ? Math.round((data.summary.freeCount / data.summary.total) * 100)
              : 0}
            %
          </p>
        </header>

        {/* 관광지 리스트 (메인 콘텐츠) */}
        <section className="space-y-3">
          <h2 className="font-semibold text-sm">인기 관광지</h2>
          {spots.map((spot) => (
            <SpotCard key={spot.name} spot={spot} />
          ))}
        </section>

        {/* 하단 링크 */}
        <div className="flex items-center justify-between pt-2 border-t">
          <a
            href="https://korean.visitkorea.or.kr/dgtourcard/tour50.do"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs text-blue-600 hover:text-blue-800 transition-colors"
          >
            반값여행 신청하기
            <ExternalLink className="size-3" />
          </a>
          <Link
            to="/event/halfprice-travel"
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            다른 지역 보기
          </Link>
        </div>
      </div>
    </div>
  )
}

function SpotCard({ spot }: { spot: Spot }) {
  const hasParking = spot.nearbyParking.length > 0

  return (
    <div className="bg-white rounded-xl border overflow-hidden">
      {/* 이미지 */}
      {spot.imageUrl && (
        <div className="aspect-[2/1] overflow-hidden">
          <img
            src={spot.imageUrl}
            alt={spot.name}
            loading="lazy"
            decoding="async"
            className="w-full h-full object-cover"
          />
        </div>
      )}

      {/* 콘텐츠 */}
      <div className="p-4 space-y-3">
        <div>
          <h3 className="font-semibold text-base">{spot.name}</h3>
          {spot.address && (
            <div className="flex items-center gap-1 mt-1">
              <MapPin className="size-3 text-muted-foreground shrink-0" />
              <span className="text-xs text-muted-foreground">{spot.address}</span>
            </div>
          )}
        </div>

        {/* 매력 소개 */}
        <p className="text-sm text-muted-foreground leading-relaxed">
          {spot.longDescription ?? spot.description}
        </p>

        {/* 이용 팁 */}
        {spot.tips && spot.tips.length > 0 && (
          <div className="bg-gray-50 rounded-lg p-3 space-y-1.5">
            <div className="flex items-center gap-1 text-xs font-medium text-foreground">
              <Info className="size-3" />
              이용 팁
            </div>
            {spot.tips.map((tip) => (
              <div key={tip} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <span className="shrink-0 mt-0.5">·</span>
                <span>{tip}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 주변 주차장 */}
      {hasParking ? (
        <div className="border-t px-4 py-3 space-y-1.5">
          <p className="text-xs font-medium text-foreground flex items-center gap-1">
            <Navigation className="size-3" />
            주변 주차장
          </p>
          {spot.nearbyParking.slice(0, 3).map((p) => (
            <Link
              key={p.id}
              to="/wiki/$slug"
              params={{ slug: makeParkingSlug(p.name, p.id) }}
              className="flex items-center gap-2 text-xs hover:bg-gray-50 rounded-md px-2 py-1.5 -mx-2 transition-colors"
            >
              <span className="truncate flex-1">{p.name}</span>
              <div className={`size-2 rounded-full shrink-0 ${getDifficultyColor(p.finalScore)}`} />
              <span className="shrink-0">{getDifficultyIcon(p.finalScore)}</span>
              {p.isFree && <span className="text-green-600 shrink-0">무료</span>}
              <span className="text-muted-foreground shrink-0">
                {p.distanceM < 1000 ? `${p.distanceM}m` : `${(p.distanceM / 1000).toFixed(1)}km`}
              </span>
            </Link>
          ))}
        </div>
      ) : (
        <div className="border-t px-4 py-3">
          <p className="text-xs text-muted-foreground">주변 주차장 정보 준비 중</p>
        </div>
      )}
    </div>
  )
}
