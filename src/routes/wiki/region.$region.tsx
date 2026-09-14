import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { sql } from 'drizzle-orm'
import { ChevronRight, MapPin } from 'lucide-react'
import { RankingSection } from '@/components/wiki/RankingSection'
import { getDb } from '@/db'
import { getRegionByLabel, type ParkingRegion } from '@/lib/parking-regions'
import { cachedJson } from '@/server/cache-json'
import { curateLots } from '@/server/lot-name-quality'
import {
  computeRegionStats,
  ENRICHED_REGIONS,
  type RegionStats,
  type RegionStatsRow,
} from '@/server/region-stats'
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
    // 캐시 없이 TTFB 중앙 1.46s 였다 (09-14, 17개). 순위·집계는 크론 주기로만 바뀐다
    return cachedJson(`region-hub-v1/${encodeURIComponent(region.label)}`, 3600, () =>
      loadRegionHub(region),
    )
  })

async function loadRegionHub(region: ParkingRegion) {
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
        LIMIT 24`,
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
        LIMIT 24`,
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
        LIMIT 24`,
    ),
  )

  // 색인 실험 처치 그룹만 집계를 보여준다 (docs/exec-plans/region-hub-indexing-2026-09-14.md).
  // 지역 전체를 읽는다(rows_read 약 5.4만) — 캐시로 지역당 1시간 1회
  let stats: RegionStats | null = null
  if (ENRICHED_REGIONS.has(region.label)) {
    const statRows = (await db.all(
      sql.raw(
        `SELECT p.type, p.is_free, p.total_spaces, p.weekday_start, p.weekday_end,
            p.base_time, p.base_fee, p.extra_time, p.extra_fee, p.daily_max, p.address
          FROM parking_lots p
          WHERE ${regionWhere}`,
      ),
    )) as RegionStatsRow[]
    stats = computeRegionStats(statRows, region.prefixes)
  }

  return {
    label: region.label,
    lotCount: Number(statsRow?.lot_count ?? 0),
    reviewCount: Number(statsRow?.review_count ?? 0),
    districts,
    stats,
    // 이름 품질 게이트로 걸러낸 뒤 9개 (D-4) — 쿼리는 걸러질 몫까지 24개를 뽑는다
    easy: curateLots(toLots(easyRows), 9),
    popular: curateLots(toLots(popularRows), 9),
    free: curateLots(toLots(freeRows), 9),
  }
}

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
  const { label, lotCount, reviewCount, districts, stats, easy, popular, free } =
    Route.useLoaderData()
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
              search={{ region: label, page: 1 }}
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

        {stats && <RegionStatsSection label={label} stats={stats} />}

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
                  search={{ region: label, district: district.name, page: 1 }}
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

function pct(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—'
}

/**
 * 지역 집계 — DB 숫자로만 쓴 문장과 표 (색인 실험 처치 그룹).
 * 모수가 다른 숫자(요금 계산 가능 lot, 운영시간 확인 lot)는 문장에 모수를 함께 적는다.
 */
function RegionStatsSection({ label, stats }: { label: string; stats: RegionStats }) {
  const {
    total,
    outdoor,
    attached,
    onStreet,
    free,
    large,
    feeMedian,
    feeCount,
    hours24,
    hoursKnown,
  } = stats
  return (
    <section className="space-y-4">
      <div className="space-y-1 px-1">
        <h2 className="text-xl font-bold">{label} 주차장 한눈에 보기</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {label} 주차장 {total.toLocaleString()}곳 중 노외 주차장은 {outdoor.toLocaleString()}곳(
          {pct(outdoor, total)}), 건물 부설 주차장은 {attached.toLocaleString()}곳(
          {pct(attached, total)}), 노상 주차장은 {onStreet.toLocaleString()}곳(
          {pct(onStreet, total)})입니다. 무료 주차장은 {free.toLocaleString()}곳(
          {pct(free, total)})이고, 주차면 200면 이상인 대형 주차장은 {large.toLocaleString()}
          곳입니다.
          {feeMedian !== null &&
            ` 요금표로 1시간 요금을 계산할 수 있는 유료 주차장 ${feeCount.toLocaleString()}곳의 1시간 요금 중앙값은 ${feeMedian.toLocaleString()}원입니다.`}
          {hoursKnown > 0 &&
            ` 평일 운영시간이 확인된 ${hoursKnown.toLocaleString()}곳 중 ${hours24.toLocaleString()}곳(${pct(hours24, hoursKnown)})이 24시간 운영합니다.`}
        </p>
      </div>

      {stats.districts.length > 0 && (
        <div className="overflow-x-auto rounded-2xl bg-white">
          <table className="w-full text-sm">
            <caption className="sr-only">{label} 구·시·군별 주차장 요약</caption>
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="px-4 py-2.5 font-medium">구·시·군</th>
                <th className="px-4 py-2.5 text-right font-medium">주차장</th>
                <th className="px-4 py-2.5 text-right font-medium">무료</th>
                <th className="px-4 py-2.5 text-right font-medium">유료 1시간 요금(중앙값)</th>
              </tr>
            </thead>
            <tbody>
              {stats.districts.map((d) => (
                <tr key={d.name} className="border-b last:border-0">
                  <td className="px-4 py-2.5 font-medium">{d.name}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">
                    {d.count.toLocaleString()}곳
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">
                    {d.free.toLocaleString()}곳 ({pct(d.free, d.count)})
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">
                    {d.feeMedian !== null
                      ? `${d.feeMedian.toLocaleString()}원 (${d.feeCount.toLocaleString()}곳 기준)`
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
