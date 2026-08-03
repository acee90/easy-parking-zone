import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { sql } from 'drizzle-orm'
import { ChevronRight, MapPin } from 'lucide-react'
import { RankingSection } from '@/components/wiki/RankingSection'
import { getDb } from '@/db'
import { getRegionByLabel } from '@/lib/parking-regions'
import { type ParkingLotRow, rowToParkingLot } from '@/server/transforms'
import type { ParkingLot } from '@/types/parking'

const SITE_BASE = 'https://easy-parking.xyz'

type RegionParkingLot = ParkingLot & {
  contentCounts: {
    reviews: number
    media: number
    web: number
  }
}

interface DistrictGroup {
  name: string
  count: number
}

const LOT_SELECT = `SELECT p.*,
  s.final_score as avg_score,
  COALESCE(s.review_count, 0) as review_count,
  s.reliability,
  (SELECT COUNT(*) FROM parking_media pm WHERE pm.parking_lot_id = p.id) as media_count,
  (SELECT COUNT(*) FROM web_sources ws WHERE ws.parking_lot_id = p.id AND ws.relevance_score >= 40) as web_count`

type RegionParkingLotRow = ParkingLotRow & {
  media_count?: number | null
  web_count?: number | null
}

function toLots(rows: unknown[]): RegionParkingLot[] {
  return (rows as unknown as RegionParkingLotRow[]).map((row) => ({
    ...rowToParkingLot(row),
    contentCounts: {
      reviews: Number(row.review_count ?? 0),
      media: Number(row.media_count ?? 0),
      web: Number(row.web_count ?? 0),
    },
  }))
}

const fetchRegionHub = createServerFn({ method: 'GET' })
  .inputValidator((data: unknown) => {
    if (typeof data !== 'string') throw new Error('region must be a string')
    return data
  })
  .handler(async ({ data: regionLabel }) => {
    const region = getRegionByLabel(regionLabel)
    if (!region) throw notFound()

    const db = getDb()
    // prefixes는 PARKING_REGIONS 상수 — 사용자 입력이 아니므로 sql.raw 안전.
    const regionWhere = region.prefixes.map((prefix) => `p.address LIKE '${prefix}%'`).join(' OR ')

    const statsRow = (await db.get(
      sql.raw(
        `SELECT COUNT(*) AS lot_count, COALESCE(SUM(s.review_count), 0) AS review_count
        FROM parking_lots p
        LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
        WHERE ${regionWhere}`,
      ),
    )) as { lot_count: number; review_count: number } | null

    // 구·시·군 분류: 주소 2번째 토큰 기준. '서울특별시 강남구 …' → 강남구, '경기 성남시 …' → 성남시.
    const districtRows = (await db.all(
      sql.raw(
        `SELECT
          CASE WHEN instr(rest, ' ') > 0 THEN substr(rest, 1, instr(rest, ' ') - 1) ELSE rest END AS district,
          COUNT(*) AS cnt
        FROM (
          SELECT trim(substr(p.address, instr(p.address, ' ') + 1)) AS rest
          FROM parking_lots p
          WHERE (${regionWhere}) AND instr(p.address, ' ') > 0
        )
        GROUP BY district
        ORDER BY cnt DESC`,
      ),
    )) as Array<{ district: string; cnt: number }>

    // 시·군·구 형태만 유지 — '서울특별시'처럼 광역명이 다시 나오는 오염 토큰 제거.
    const districts: DistrictGroup[] = districtRows
      .filter(
        (row) =>
          /[시군구]$/.test(row.district) &&
          !region.prefixes.some((prefix) => row.district.startsWith(prefix)),
      )
      .map((row) => ({ name: row.district, count: Number(row.cnt) }))

    const easyRows = await db.all(
      sql.raw(
        `${LOT_SELECT}
        FROM parking_lots p
        LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
        WHERE (${regionWhere}) AND p.curation_tag = 'easy'
        ORDER BY COALESCE(s.final_score, 0) DESC, p.total_spaces DESC
        LIMIT 9`,
      ),
    )

    const popularRows = await db.all(
      sql.raw(
        `${LOT_SELECT}
        FROM parking_lots p
        JOIN parking_lot_stats s ON s.parking_lot_id = p.id
        WHERE (${regionWhere})
          AND (SELECT COUNT(*) FROM web_sources ws
               WHERE ws.parking_lot_id = p.id AND ws.relevance_score >= 40) > 0
        ORDER BY web_count DESC
        LIMIT 9`,
      ),
    )

    const freeRows = await db.all(
      sql.raw(
        `${LOT_SELECT}
        FROM parking_lots p
        LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
        WHERE (${regionWhere}) AND p.is_free = 1
          AND (
            p.total_spaces >= 100
            OR p.curation_reason IS NOT NULL
            OR EXISTS (SELECT 1 FROM web_sources ws WHERE ws.parking_lot_id = p.id)
          )
        ORDER BY
          CASE WHEN p.curation_reason IS NOT NULL THEN 1 ELSE 0 END DESC,
          COALESCE(s.final_score, 0) DESC,
          p.total_spaces DESC
        LIMIT 9`,
      ),
    )

    return {
      label: region.label,
      lotCount: Number(statsRow?.lot_count ?? 0),
      reviewCount: Number(statsRow?.review_count ?? 0),
      districts,
      easy: toLots(easyRows),
      popular: toLots(popularRows),
      free: toLots(freeRows),
    }
  })

function buildRegionCanonical(label: string): string {
  return `${SITE_BASE}/wiki/region/${encodeURIComponent(label)}`
}

export const Route = createFileRoute('/wiki/region/$region')({
  loader: ({ params }) => fetchRegionHub({ data: params.region }),
  head: ({ loaderData }) => {
    const label = loaderData?.label ?? ''
    const title = `${label} 주차장 난이도·요금·운영시간 비교 | 쉬운주차장`
    const description = `${label} 지역 주차장을 구·시·군별로 나눠 보고, 초보 추천·무료 주차장을 실제 후기 기반으로 비교하세요.`
    return {
      meta: [
        { title },
        { name: 'description', content: description },
        {
          name: 'robots',
          content: 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1',
        },
        { property: 'og:title', content: title },
        { property: 'og:description', content: description },
        { property: 'og:type', content: 'website' },
        { property: 'og:url', content: buildRegionCanonical(label) },
        { property: 'og:site_name', content: '쉽주' },
      ],
    }
  },
  component: RegionHubPage,
})

function RegionHubPage() {
  const { label, lotCount, reviewCount, districts, easy, popular, free } = Route.useLoaderData()
  // head links가 SSR 직렬화되지 않아 canonical은 React 19 metadata hoisting으로 렌더.
  const canonicalUrl = buildRegionCanonical(label)

  const breadcrumbJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: '주차장 둘러보기', item: `${SITE_BASE}/wiki` },
      { '@type': 'ListItem', position: 2, name: `${label} 주차장`, item: canonicalUrl },
    ],
  }

  return (
    <div className="min-h-screen bg-zinc-100">
      <link rel="canonical" href={canonicalUrl} />
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON.stringify output is safe
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd) }}
      />
      <div className="mx-auto max-w-6xl px-4 py-6 space-y-10">
        <section className="space-y-2">
          <nav
            aria-label="breadcrumb"
            className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground"
          >
            <Link to="/wiki" className="transition-colors hover:text-foreground hover:underline">
              둘러보기
            </Link>
            <ChevronRight className="size-3 shrink-0" />
            <span className="font-medium text-foreground">{label} 주차장</span>
          </nav>
          <div className="flex items-center justify-between gap-4">
            <h1 className="text-2xl font-bold leading-tight tracking-tight md:text-3xl">
              {label} 주차장
            </h1>
            <Link
              to="/wiki/all"
              search={{ region: label }}
              className="inline-flex h-8 shrink-0 items-center gap-0.5 rounded-full border border-zinc-200 bg-white pl-3 pr-2 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-50 active:bg-zinc-100"
            >
              전체 목록
              <ChevronRight className="size-3.5" />
            </Link>
          </div>
          <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
            {label} 지역 주차장{' '}
            <strong className="font-semibold tabular-nums text-foreground">
              {lotCount.toLocaleString()}
            </strong>
            곳의 요금, 운영시간, 초보 난이도를 비교할 수 있습니다.
            {reviewCount > 0 && (
              <>
                {' '}
                리뷰{' '}
                <strong className="font-semibold tabular-nums text-foreground">
                  {reviewCount.toLocaleString()}
                </strong>
                개가 쌓여 있습니다.
              </>
            )}
          </p>
        </section>

        {districts.length > 0 && (
          <section>
            <div className="mb-4 px-1 space-y-1">
              <h2 className="text-xl font-bold">구·시·군별 주차장</h2>
              <p className="text-sm leading-relaxed text-muted-foreground">
                지역을 선택하면 해당 구·시·군의 주차장 목록으로 이동합니다.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {districts.map((district) => (
                <Link
                  key={district.name}
                  to="/wiki/all"
                  search={{ region: label, district: district.name }}
                  className="flex items-center justify-between gap-2 rounded-2xl bg-white px-4 py-3.5 transition-colors hover:bg-zinc-50 active:bg-zinc-100"
                >
                  <span className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
                    <MapPin className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{district.name}</span>
                  </span>
                  <span className="shrink-0 text-xs font-medium tabular-nums text-muted-foreground">
                    {district.count.toLocaleString()}곳
                  </span>
                </Link>
              ))}
            </div>
          </section>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-5 gap-y-10">
          <RankingSection
            title={`${label} 초보 추천 주차장`}
            description="넓고 여유로워 초보도 편한 주차장"
            lots={easy}
            layout="carousel"
            className="md:col-span-2"
          />
          <RankingSection
            title={`${label} 웹에서 많이 언급된 주차장`}
            description="블로그/커뮤니티에서 자주 언급되는 주차장"
            lots={popular}
          />
          <RankingSection
            title={`${label} 무료 주차장`}
            description="무료이면서 정보 신호가 있는 주차장"
            lots={free}
          />
        </div>
      </div>
    </div>
  )
}
