import { createFileRoute, Link } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { sql } from 'drizzle-orm'
import {
  ChevronRight,
  Clock,
  CreditCard,
  MapPin,
  MapPinPen,
  ParkingSquare,
  Star,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { RankingSection } from '@/components/wiki/RankingSection'
import { getDb } from '@/db'
import { makeParkingSlug } from '@/lib/slug'
import { fetchSiteStats } from '@/server/parking'
import { type ParkingLotRow, rowToParkingLot } from '@/server/transforms'
import type { ParkingLot } from '@/types/parking'

interface RegionGroup {
  label: string
  prefix: string
  lots: WikiParkingLot[]
}

type WikiParkingLot = ParkingLot & {
  contentCounts: {
    reviews: number
    media: number
    web: number
  }
}

const REGIONS = [
  { label: '서울', prefix: '서울' },
  { label: '경기', prefix: '경기' },
  { label: '부산', prefix: '부산' },
  { label: '인천', prefix: '인천' },
  { label: '대구', prefix: '대구' },
  { label: '대전', prefix: '대전' },
  { label: '광주', prefix: '광주' },
  { label: '울산', prefix: '울산' },
  { label: '제주', prefix: '제주' },
]

const LOT_SELECT = `SELECT p.*,
  s.final_score as avg_score,
  COALESCE(s.user_review_count, 0) + COALESCE(s.community_count, 0) as review_count,
  s.reliability,
  (SELECT COUNT(*) FROM parking_media pm WHERE pm.parking_lot_id = p.id) as media_count,
  (SELECT COUNT(*) FROM web_sources ws WHERE ws.parking_lot_id = p.id AND ws.relevance_score >= 40) as web_count`

type WikiParkingLotRow = ParkingLotRow & {
  media_count?: number | null
  web_count?: number | null
}

function toLots(rows: unknown[]): WikiParkingLot[] {
  return (rows as unknown as WikiParkingLotRow[]).map((row) => ({
    ...rowToParkingLot(row),
    contentCounts: {
      reviews: Number(row.review_count ?? 0),
      media: Number(row.media_count ?? 0),
      web: Number(row.web_count ?? 0),
    },
  }))
}

const fetchWikiHome = createServerFn({ method: 'GET' }).handler(async () => {
  const db = getDb()

  // 넓은 주차장 TOP (주차면 수 기준)
  const spaciousRows = await db.all(
    sql.raw(
      `${LOT_SELECT}
      FROM parking_lots p
      LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
      WHERE p.total_spaces >= 200
      ORDER BY p.total_spaces DESC, COALESCE(s.final_score, 0) DESC
      LIMIT 12`,
    ),
  )

  // 초보 추천 TOP
  const easyRows = await db.all(
    sql.raw(
      `${LOT_SELECT}
      FROM parking_lots p
      LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
      WHERE p.curation_tag = 'easy'
      ORDER BY COALESCE(s.final_score, 0) DESC, p.total_spaces DESC
      LIMIT 12`,
    ),
  )

  // 무료 주차장
  const freeRows = await db.all(
    sql.raw(
      `${LOT_SELECT}
      FROM parking_lots p
      LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
      WHERE p.is_free = 1
        AND (
          p.total_spaces >= 100
          OR p.curation_reason IS NOT NULL
          OR EXISTS (SELECT 1 FROM web_sources ws WHERE ws.parking_lot_id = p.id)
        )
      ORDER BY
        CASE WHEN p.curation_reason IS NOT NULL THEN 1 ELSE 0 END DESC,
        COALESCE(s.final_score, 0) DESC,
        p.total_spaces DESC
      LIMIT 12`,
    ),
  )

  // 웹에서 많이 언급된 주차장 (광고 제외)
  const popularRows = await db.all(
    sql.raw(
      `SELECT p.*,
        s.final_score as avg_score,
        COALESCE(s.user_review_count, 0) + COALESCE(s.community_count, 0) as review_count,
        s.reliability,
        (SELECT COUNT(*) FROM parking_media pm WHERE pm.parking_lot_id = p.id) as media_count,
        (SELECT COUNT(*) FROM web_sources ws
         WHERE ws.parking_lot_id = p.id AND ws.relevance_score >= 40) as web_count
      FROM parking_lots p
      JOIN parking_lot_stats s ON s.parking_lot_id = p.id
      WHERE (SELECT COUNT(*) FROM web_sources ws
             WHERE ws.parking_lot_id = p.id AND ws.relevance_score >= 40) > 0
      ORDER BY web_count DESC
      LIMIT 16`,
    ),
  )

  // 최근 보강된 주차장
  const recentlyUpdatedRows = await db.all(
    sql.raw(
      `${LOT_SELECT}
      FROM parking_lots p
      LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
      WHERE p.curation_reason IS NOT NULL
        OR p.notes IS NOT NULL
        OR s.ai_summary IS NOT NULL
        OR s.ai_tip_pricing IS NOT NULL
        OR s.ai_tip_visit IS NOT NULL
        OR s.ai_tip_alternative IS NOT NULL
      ORDER BY
        COALESCE(s.ai_summary_updated_at, p.updated_at, p.created_at) DESC,
        COALESCE(s.final_score, 0) DESC
      LIMIT 12`,
    ),
  )

  const regions = await Promise.all(
    REGIONS.map(async (region): Promise<RegionGroup> => {
      const rows = await db.all(
        sql.raw(
          `${LOT_SELECT}
          FROM parking_lots p
          LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
          WHERE p.address LIKE '${region.prefix}%'
            AND (
              p.curation_reason IS NOT NULL
              OR p.total_spaces >= 100
              OR EXISTS (SELECT 1 FROM web_sources ws WHERE ws.parking_lot_id = p.id)
            )
          ORDER BY
            CASE WHEN p.curation_reason IS NOT NULL THEN 1 ELSE 0 END DESC,
            COALESCE(s.final_score, 0) DESC,
            p.total_spaces DESC
          LIMIT 8`,
        ),
      )
      return { ...region, lots: toLots(rows) }
    }),
  )

  const siteStats = await fetchSiteStats()

  return {
    spacious: toLots(spaciousRows),
    easy: toLots(easyRows),
    free: toLots(freeRows),
    popular: toLots(popularRows),
    recentlyUpdated: toLots(recentlyUpdatedRows),
    regions,
    siteStats,
  }
})

export const Route = createFileRoute('/wiki/')({
  loader: () => fetchWikiHome(),
  head: () => ({
    meta: [
      { title: '주차장 둘러보기 | 쉽주' },
      {
        name: 'description',
        content: '초보 추천부터 넓은 주차장 TOP까지. 실제 데이터 기반 전국 주차장 큐레이션.',
      },
      {
        name: 'robots',
        content: 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1',
      },
      { httpEquiv: 'content-language', content: 'ko' },
      { property: 'og:title', content: '주차장 둘러보기 | 쉽주' },
      {
        property: 'og:description',
        content: '초보 추천부터 넓은 주차장 TOP까지. 실제 데이터 기반 전국 주차장 큐레이션.',
      },
      { property: 'og:type', content: 'website' },
      { property: 'og:url', content: 'https://easy-parking.xyz/wiki' },
      {
        property: 'og:image',
        content: 'https://easy-parking.xyz/og-image.png',
      },
      { property: 'og:site_name', content: '쉽주' },
      { name: 'twitter:card', content: 'summary_large_image' },
      { name: 'twitter:title', content: '주차장 둘러보기 | 쉽주' },
      {
        name: 'twitter:description',
        content: '초보 추천부터 넓은 주차장 TOP까지. 실제 데이터 기반 전국 주차장 큐레이션.',
      },
      {
        name: 'twitter:image',
        content: 'https://easy-parking.xyz/og-image.png',
      },
    ],
    links: [{ rel: 'canonical', href: 'https://easy-parking.xyz/wiki' }],
  }),
  component: WikiHomePage,
})

function WikiHomePage() {
  const { spacious, easy, free, popular, recentlyUpdated, regions, siteStats } =
    Route.useLoaderData()

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto px-4 py-6 space-y-6">
        <section className="space-y-4">
          <div className="space-y-2">
            <h1 className="text-3xl font-bold leading-tight tracking-normal md:text-4xl">
              전국 주차장 둘러보기
            </h1>
            <p className="max-w-3xl text-base leading-relaxed text-muted-foreground">
              주차 전에 미리 확인하세요. 요금, 운영시간, 주차면 수, 초보 운전자 난이도까지 한눈에
              비교할 수 있습니다. 실제 블로그·유튜브 후기를 모아 정리했으며, 아래 목록은 정보가 가장
              잘 정리된 주차장부터 보여드립니다.
            </p>
          </div>
          <SiteStatsBar siteStats={siteStats} />
        </section>

        {/* 반값여행 이벤트 배너 */}
        <Link
          to="/event/halfprice-travel"
          className="block bg-linear-to-r from-blue-50 to-indigo-50 rounded-xl border border-blue-100 p-5 hover:border-blue-300 transition-all"
        >
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="bg-blue-600 text-white px-2 py-0.5 rounded-full text-xs font-bold">
                  반값여행
                </span>
                <span className="text-xs text-muted-foreground">4~6월 · 여행비 50% 환급</span>
              </div>
              <h2 className="text-lg font-bold">16개 지역 관광지 + 주차 가이드</h2>
              <p className="mt-0.5 text-sm text-muted-foreground">
                관광지별 주변 주차장 안내 · 1인 최대 10만원 환급
              </p>
            </div>
            <ChevronRight className="size-5 text-blue-400 shrink-0" />
          </div>
        </Link>

        {/* 전국 랭킹 */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <RankingSection
            title="초보 추천 주차장"
            description="넓고 여유로워 초보도 편한 주차장"
            lots={easy}
          />
          <RankingSection
            title="넓은 주차장 TOP"
            description="주차면 수 200면 이상, 여유롭게 주차"
            lots={spacious}
          />
          <RankingSection
            title="무료 주차장"
            description="무료이면서 정보 신호가 있는 주차장"
            lots={free}
          />
          <RankingSection
            title="최근 정보 보강"
            description="요약, 팁, 특이사항이 보강된 주차장"
            lots={recentlyUpdated}
          />
          <RankingSection
            title="웹에서 많이 언급된 주차장"
            description="블로그/커뮤니티에서 자주 언급되는 주차장"
            lots={popular}
            className="md:col-span-2"
          />
        </div>

        <section className="rounded-xl border bg-white p-5">
          <div className="mb-4 space-y-1">
            <h2 className="text-xl font-bold">지역별 대표 주차장</h2>
            <p className="text-base leading-relaxed text-muted-foreground">
              지역별 목록은 주차면 수, 난이도, 큐레이션 사유, 웹 언급량이 있는 주차장을 우선합니다.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
            {regions
              .filter((region) => region.lots.length > 0)
              .map((region) => (
                <RegionList key={region.prefix} region={region} />
              ))}
          </div>
        </section>

        <section className="rounded-xl border bg-white p-5">
          <div className="mb-4 space-y-1">
            <h2 className="text-xl font-bold">주차 전에 확인할 기준</h2>
            <p className="text-base leading-relaxed text-muted-foreground">
              같은 목적지라도 요금, 운영시간, 주차면 수, 진입 난이도에 따라 체감이 크게 달라집니다.
              쉬운주차장은 이 기준을 페이지별로 모아 비교할 수 있게 정리합니다.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <CriteriaItem icon={<CreditCard className="size-4" />} title="요금">
              무료 여부, 기본요금, 추가요금, 할인 메모를 먼저 확인합니다.
            </CriteriaItem>
            <CriteriaItem icon={<Clock className="size-4" />} title="운영시간">
              평일, 토요일, 공휴일 운영시간이 다른 주차장을 구분합니다.
            </CriteriaItem>
            <CriteriaItem icon={<ParkingSquare className="size-4" />} title="근거 수">
              리뷰, 영상, 웹사이트 수가 충분한 곳은 방문 전 확인할 정보가 더 많습니다.
            </CriteriaItem>
            <CriteriaItem icon={<Star className="size-4" />} title="난이도">
              진입로, 통로, 주차면, 출차 후기를 함께 보고 초보 운전 부담을 줄입니다.
            </CriteriaItem>
          </div>
        </section>
      </div>
    </div>
  )
}

function RegionList({ region }: { region: RegionGroup }) {
  return (
    <div>
      <div className="mb-2 flex items-center gap-1.5 text-sm font-bold">
        <MapPin className="size-4 text-muted-foreground" />
        {region.label}
      </div>
      <div className="divide-y rounded-lg border">
        {region.lots.map((lot) => (
          <Link
            key={lot.id}
            to="/wiki/$slug"
            params={{ slug: makeParkingSlug(lot.name, lot.id) }}
            className="flex items-center gap-2 px-3 py-2.5 text-base transition-colors hover:bg-gray-50"
          >
            <span className="min-w-0 flex-1 truncate font-medium">{lot.name}</span>
            <LotEvidence lot={lot} />
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          </Link>
        ))}
      </div>
    </div>
  )
}

function formatCount(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}만`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}천`
  return n.toLocaleString()
}

function SiteStatsBar({
  siteStats,
}: {
  siteStats: { parkingLots: number; reviews: number; mediaPosts: number }
}) {
  return (
    <div className="flex flex-wrap gap-2 text-sm">
      <span className="rounded-full border bg-white px-3 py-1 font-medium">
        주차장 <strong className="text-foreground">{formatCount(siteStats.parkingLots)}</strong>
      </span>
      <span className="rounded-full border bg-white px-3 py-1 font-medium">
        리뷰 <strong className="text-foreground">{formatCount(siteStats.reviews)}</strong>
      </span>
      <span className="rounded-full border bg-white px-3 py-1 font-medium">
        영상/포스팅 <strong className="text-foreground">{formatCount(siteStats.mediaPosts)}</strong>
      </span>
    </div>
  )
}

function CriteriaItem({
  icon,
  title,
  children,
}: {
  icon: ReactNode
  title: string
  children: ReactNode
}) {
  return (
    <div className="rounded-lg border bg-gray-50 p-4">
      <div className="mb-2 flex items-center gap-2 text-sm font-bold">
        <span className="text-muted-foreground">{icon}</span>
        {title}
      </div>
      <p className="text-sm leading-relaxed text-muted-foreground">{children}</p>
    </div>
  )
}

function LotEvidence({ lot }: { lot: WikiParkingLot }) {
  const score = lot.difficulty.score
  const totalSources = lot.contentCounts.reviews + lot.contentCounts.media + lot.contentCounts.web

  return (
    <div className="flex shrink-0 items-center gap-3 text-sm font-semibold text-muted-foreground">
      <span className="flex w-12 items-center gap-1.5">
        <Star className="size-3.5 fill-yellow-400 text-yellow-400 shrink-0" />
        <span className="tabular-nums">{score === null ? '-' : score.toFixed(1)}</span>
      </span>
      <span className="flex w-10 items-center gap-1.5 font-medium">
        {totalSources > 0 && (
          <>
            <MapPinPen className="size-3.5 shrink-0" />
            <span className="tabular-nums">{totalSources}</span>
          </>
        )}
      </span>
    </div>
  )
}
