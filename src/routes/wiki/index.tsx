import { createFileRoute, Link } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { sql } from 'drizzle-orm'
import { ChevronRight, Clock, CreditCard, ParkingSquare, Star } from 'lucide-react'
import type { ReactNode } from 'react'
import { RankingSection } from '@/components/wiki/RankingSection'
import { getDb } from '@/db'
import { PARKING_REGIONS } from '@/lib/parking-regions'
import { curateLots } from '@/server/lot-name-quality'
import { fetchSiteStats } from '@/server/parking'
import { type ParkingLotRow, rowToParkingLot } from '@/server/transforms'
import type { ParkingLot } from '@/types/parking'

interface RegionCount {
  label: string
  count: number
}

type WikiParkingLot = ParkingLot & {
  contentCounts: {
    reviews: number
    media: number
    web: number
  }
}

const LOT_SELECT = `SELECT p.*,
  s.final_score as avg_score,
  COALESCE(s.review_count, 0) as review_count,
  s.reliability,
  (SELECT COUNT(*) FROM parking_media pm WHERE pm.parking_lot_id = p.id) as media_count,
  (SELECT COUNT(*) FROM web_sources ws WHERE ws.parking_lot_id = p.id AND ws.relevance_score >= 40 AND ws.filter_passed_v2 IS NOT 0) as web_count`

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

  // 랭킹은 이름 품질 게이트(curateLots)로 걸러낸 뒤 12개를 쓴다 — 걸러질 몫까지 넉넉히 뽑는다 (D-4)
  const POOL = 30

  // 넓은 주차장 TOP (주차면 수 기준). 노상은 도로 구간 전체가 한 행이라 면수가 부풀려져 있다 (시화공단 내 도로 4,261면)
  const spaciousRows = await db.all(
    sql.raw(
      `${LOT_SELECT}
      FROM parking_lots p
      LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
      WHERE p.total_spaces >= 200 AND p.type <> '노상'
      ORDER BY p.total_spaces DESC, COALESCE(s.final_score, 0) DESC
      LIMIT ${POOL}`,
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
      LIMIT ${POOL}`,
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
      LIMIT ${POOL}`,
    ),
  )

  // 웹에서 많이 언급된 주차장 (광고 제외)
  const popularRows = await db.all(
    sql.raw(
      `SELECT p.*,
        s.final_score as avg_score,
        COALESCE(s.review_count, 0) as review_count,
        s.reliability,
        (SELECT COUNT(*) FROM parking_media pm WHERE pm.parking_lot_id = p.id) as media_count,
        (SELECT COUNT(*) FROM web_sources ws
         WHERE ws.parking_lot_id = p.id AND ws.relevance_score >= 40 AND ws.filter_passed_v2 IS NOT 0) as web_count
      FROM parking_lots p
      JOIN parking_lot_stats s ON s.parking_lot_id = p.id
      WHERE (SELECT COUNT(*) FROM web_sources ws
             WHERE ws.parking_lot_id = p.id AND ws.relevance_score >= 40 AND ws.filter_passed_v2 IS NOT 0) > 0
      ORDER BY web_count DESC
      LIMIT ${POOL}`,
    ),
  )

  // 최근 리뷰 달린 주차장 (사용자 리뷰 최신순)
  const recentlyReviewedRows = await db.all(
    sql.raw(
      `${LOT_SELECT}
      FROM parking_lots p
      LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
      JOIN (
        SELECT parking_lot_id, MAX(created_at) AS last_review
        FROM user_reviews
        GROUP BY parking_lot_id
      ) r ON r.parking_lot_id = p.id
      ORDER BY r.last_review DESC
      LIMIT 12`,
    ),
  )

  // 지역별 주차장 수 — prefixes는 PARKING_REGIONS 상수라 sql.raw 안전.
  const regionCaseSql = PARKING_REGIONS.flatMap((region) =>
    region.prefixes.map((prefix) => `WHEN p.address LIKE '${prefix}%' THEN '${region.label}'`),
  ).join(' ')
  const regionCountRows = (await db.all(
    sql.raw(
      `SELECT CASE ${regionCaseSql} END AS label, COUNT(*) AS cnt
      FROM parking_lots p
      GROUP BY label`,
    ),
  )) as Array<{ label: string | null; cnt: number }>
  const countByLabel = new Map(regionCountRows.map((row) => [row.label, Number(row.cnt)]))
  const regions: RegionCount[] = PARKING_REGIONS.map((region) => ({
    label: region.label,
    count: countByLabel.get(region.label) ?? 0,
  })).filter((region) => region.count > 0)

  const siteStats = await fetchSiteStats()

  return {
    spacious: curateLots(toLots(spaciousRows), 12),
    easy: curateLots(toLots(easyRows), 12),
    free: curateLots(toLots(freeRows), 12),
    popular: curateLots(toLots(popularRows), 16),
    recentlyReviewed: toLots(recentlyReviewedRows),
    regions,
    siteStats,
  }
})

export const Route = createFileRoute('/wiki/')({
  loader: () => fetchWikiHome(),
  head: () => ({
    meta: [
      { title: '전국 주차장 난이도·요금·운영시간 비교 | 쉬운주차장' },
      {
        name: 'description',
        content: '초보 추천부터 넓은 주차장 TOP까지. 실제 데이터 기반 전국 주차장 큐레이션.',
      },
      {
        name: 'robots',
        content: 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1',
      },
      { httpEquiv: 'content-language', content: 'ko' },
      { property: 'og:title', content: '전국 주차장 난이도·요금·운영시간 비교 | 쉬운주차장' },
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
      { name: 'twitter:title', content: '전국 주차장 난이도·요금·운영시간 비교 | 쉬운주차장' },
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
  const { spacious, easy, free, popular, recentlyReviewed, regions, siteStats } =
    Route.useLoaderData()

  return (
    <div className="min-h-screen bg-zinc-100">
      <div className="max-w-6xl mx-auto px-4 py-6 space-y-6">
        <section className="space-y-2">
          <div className="flex items-center justify-between gap-4">
            <h1 className="text-2xl font-bold leading-tight tracking-tight md:text-3xl">
              전국 주차장 둘러보기
            </h1>
            <Link
              to="/wiki/all"
              className="inline-flex h-8 shrink-0 items-center gap-0.5 rounded-full border border-zinc-200 bg-white pl-3 pr-2 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-50 active:bg-zinc-100"
            >
              전체 목록
              <ChevronRight className="size-3.5" />
            </Link>
          </div>
          <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
            요금, 운영시간, 주차면 수, 초보 난이도를 실제 블로그·유튜브 후기 기반으로 비교할 수
            있습니다.
          </p>
          <SiteStatsBar siteStats={siteStats} />
        </section>

        {/* 전국 랭킹 */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-5 gap-y-12">
          <RankingSection
            title="초보 추천 주차장"
            description="넓고 여유로워 초보도 편한 주차장"
            lots={easy}
            layout="carousel"
            className="md:col-span-2"
          />
          <RankingSection
            title="최근 리뷰 달린 주차장"
            description="사용자 리뷰가 최근에 등록된 주차장"
            lots={recentlyReviewed}
            layout="carousel"
            className="md:col-span-2"
          />
          <RankingSection
            title="웹에서 많이 언급된 주차장"
            description="블로그/커뮤니티에서 자주 언급되는 주차장"
            lots={popular}
            layout="carousel"
            className="md:col-span-2"
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
        </div>

        <section>
          <div className="mb-4 px-1 space-y-1">
            <h2 className="text-xl font-bold">지역별 주차장</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              시·도를 선택하면 구·시·군별 분류와 지역 대표 주차장을 볼 수 있습니다.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {regions.map((region) => (
              <Link
                key={region.label}
                to="/wiki/region/$region"
                params={{ region: region.label }}
                className="group flex flex-col gap-0.5 rounded-2xl bg-white p-4 transition-colors hover:bg-zinc-50 active:bg-zinc-100"
              >
                <span className="flex items-center justify-between gap-1 text-base font-bold">
                  {region.label}
                  <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
                </span>
                <span className="text-xs font-medium tabular-nums text-muted-foreground">
                  {region.count.toLocaleString()}곳
                </span>
              </Link>
            ))}
          </div>
        </section>

        <section>
          <div className="mb-4 px-1 space-y-1">
            <h2 className="text-xl font-bold">주차 전에 확인할 기준</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              같은 목적지라도 요금, 운영시간, 주차면 수, 진입 난이도에 따라 체감이 크게 달라집니다.
              쉬운주차장은 이 기준을 페이지별로 모아 비교할 수 있게 정리합니다.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <CriteriaItem icon={<CreditCard className="size-4" />} title="요금">
              무료 여부, 기본요금, 추가요금, 할인 메모를 먼저 확인합니다.
            </CriteriaItem>
            <CriteriaItem icon={<Clock className="size-4" />} title="운영시간">
              평일, 토요일, 공휴일 운영시간이 다른 주차장을 구분합니다.
            </CriteriaItem>
            <CriteriaItem icon={<ParkingSquare className="size-4" />} title="주차면 수">
              주차면 수가 큰 곳은 만차 위험과 회차 부담이 상대적으로 낮습니다.
            </CriteriaItem>
            <CriteriaItem icon={<Star className="size-4" />} title="난이도">
              진입로, 통로, 주차면, 출차 후기를 함께 보고 초보 운전 부담을 줄입니다.
            </CriteriaItem>
          </div>
        </section>

        {/* 공공데이터 출처 표기 */}
        <div className="pt-8 pb-4 text-center text-xs text-muted-foreground">
          본 서비스의 일부 주차장 기본 정보는 공공데이터포털(data.go.kr)의
          전국주차장정보표준데이터를 활용하였습니다.
        </div>
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
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1 text-sm text-muted-foreground">
      <span>
        주차장{' '}
        <strong className="font-semibold tabular-nums text-foreground">
          {formatCount(siteStats.parkingLots)}
        </strong>
      </span>
      <span>
        리뷰{' '}
        <strong className="font-semibold tabular-nums text-foreground">
          {formatCount(siteStats.reviews)}
        </strong>
      </span>
      <span>
        영상/포스팅{' '}
        <strong className="font-semibold tabular-nums text-foreground">
          {formatCount(siteStats.mediaPosts)}
        </strong>
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
    <div className="rounded-2xl bg-white p-5">
      <div className="mb-2 flex items-center gap-2 text-sm font-bold">
        <span className="text-muted-foreground">{icon}</span>
        {title}
      </div>
      <p className="text-sm leading-relaxed text-muted-foreground">{children}</p>
    </div>
  )
}
