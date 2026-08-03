import { createFileRoute, Link } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { type SQL, sql } from 'drizzle-orm'
import { ChevronLeft, ChevronRight, MapPin } from 'lucide-react'
import { z } from 'zod'
import { getDb } from '@/db'
import { getRegionByLabel } from '@/lib/parking-regions'
import { makeParkingSlug } from '@/lib/slug'
import { type ParkingLotRow, rowToParkingLot } from '@/server/transforms'

const allLotsSearchSchema = z.object({
  // page=0/음수는 min(1) 실패 → catch(1)로 보정 (OFFSET 음수/크롤 트랩 방지)
  page: z.number().int().min(1).catch(1),
  region: z.string().optional(),
  district: z.string().optional(),
})

const PAGE_SIZE = 100
const SITE_BASE = 'https://easy-parking.xyz'

/** 지역·페이지별 self-canonical URL. page=1은 쿼리 생략. */
function buildAllLotsCanonical(
  region: string | undefined,
  district: string | undefined,
  page: number,
): string {
  const params = new URLSearchParams()
  if (region) params.set('region', region)
  if (district) params.set('district', district)
  if (page > 1) params.set('page', String(page))
  const qs = params.toString()
  return qs ? `${SITE_BASE}/wiki/all?${qs}` : `${SITE_BASE}/wiki/all`
}

function buildAreaLabel(region: string | undefined, district: string | undefined): string | null {
  if (region && district) return `${region} ${district}`
  return region ?? district ?? null
}

function buildAllLotsTitle(
  region: string | undefined,
  district: string | undefined,
  page: number,
): string {
  const area = buildAreaLabel(region, district)
  const base = area ? `${area} 주차장 목록` : '전체 주차장 목록'
  const paged = page > 1 ? `${base} (${page}페이지)` : base
  return `${paged} | 쉬운주차장`
}

function buildAllLotsDescription(region: string | undefined, district: string | undefined): string {
  const area = buildAreaLabel(region, district)
  return area
    ? `${area} 지역 주차장의 요금·운영시간·주차 난이도를 한 곳에서 비교하세요.`
    : '전국 주차장의 요금·운영시간·주차 난이도를 한 곳에서 비교하세요.'
}

const fetchAllLots = createServerFn({ method: 'GET' })
  .inputValidator((data: unknown) => allLotsSearchSchema.parse(data))
  .handler(async ({ data: { page, region, district } }) => {
    const db = getDb()
    const offset = (page - 1) * PAGE_SIZE
    // region은 지역 label('경북') 우선 해석 — 표기 혼재('경북'/'경상북도')를 prefix OR로 커버.
    // label 매칭 실패 시 값 자체를 prefix로 취급 (기존 색인 URL 하위호환).
    const regionDef = getRegionByLabel(region)
    const prefixes = regionDef ? regionDef.prefixes : region ? [region] : []

    // 사용자 입력은 drizzle sql 템플릿으로 파라미터 바인딩 (주입 방지 + ? 바인딩 정상화).
    const conditions: SQL[] = []
    if (prefixes.length > 0) {
      conditions.push(
        sql`(${sql.join(
          prefixes.map((prefix) => sql`p.address LIKE ${`${prefix}%`}`),
          sql` OR `,
        )})`,
      )
    }
    // district는 주소 2번째 토큰(구·시·군) — 공백 경계 prefix 매칭.
    if (district) {
      conditions.push(sql`p.address LIKE ${`% ${district}%`}`)
    }
    const whereClause =
      conditions.length > 0 ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``

    const rows = await db.all(sql`
      SELECT p.*,
        s.final_score AS avg_score,
        COALESCE(s.review_count, 0) AS review_count,
        s.reliability
      FROM parking_lots p
      LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
      ${whereClause}
      ORDER BY COALESCE(s.final_score, 0) DESC, p.total_spaces DESC
      LIMIT ${PAGE_SIZE} OFFSET ${offset}
    `)

    const countRow = (await db.get(
      sql`SELECT COUNT(*) AS count FROM parking_lots p ${whereClause}`,
    )) as { count: number } | null
    const totalCount = Number(countRow?.count ?? 0)

    return {
      lots: (rows as unknown as ParkingLotRow[]).map(rowToParkingLot),
      totalCount,
      page,
      pageSize: PAGE_SIZE,
      region,
      district,
    }
  })

export const Route = createFileRoute('/wiki/all')({
  validateSearch: (search) => allLotsSearchSchema.parse(search),
  loaderDeps: ({ search: { page, region, district } }) => ({ page, region, district }),
  loader: ({ deps }) => fetchAllLots({ data: deps }),
  head: ({ loaderData }) => {
    const region = loaderData?.region
    const district = loaderData?.district
    const page = loaderData?.page ?? 1
    const title = buildAllLotsTitle(region, district, page)
    const description = buildAllLotsDescription(region, district)
    // 전체 목록 1페이지만 색인. 지역/구 필터 목록은 /wiki/region/ 허브가 색인 대상이라 noindex,
    // 2페이지 이상은 thin 중복 방지로 noindex.
    // follow는 유지해 상세 페이지 링크는 계속 크롤되게 한다.
    const robots =
      page > 1 || region || district
        ? 'noindex, follow'
        : 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1'
    return {
      meta: [
        { title },
        { name: 'description', content: description },
        { name: 'robots', content: robots },
        { property: 'og:title', content: title },
        { property: 'og:description', content: description },
        { property: 'og:type', content: 'website' },
        { property: 'og:url', content: buildAllLotsCanonical(region, district, page) },
      ],
    }
  },
  component: AllLotsPage,
})

function AllLotsPage() {
  const { lots, totalCount, page, pageSize, region, district } = Route.useLoaderData()
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize))
  const hasPrev = page > 1
  const hasNext = page < totalPages
  const areaLabel = buildAreaLabel(region, district)
  // head links가 SSR 직렬화되지 않아 canonical은 React 19 metadata hoisting으로 렌더.
  const canonicalUrl = buildAllLotsCanonical(region, district, page)

  return (
    <div className="min-h-screen bg-zinc-100 py-8">
      <link rel="canonical" href={canonicalUrl} />
      <div className="mx-auto max-w-4xl px-4">
        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold">
              {areaLabel ? `${areaLabel} 주차장` : '전체 주차장 목록'}
            </h1>
            <p className="text-sm text-muted-foreground">
              총 {totalCount.toLocaleString()}개의 주차장 정보가 있습니다.
            </p>
          </div>
          <Link to="/wiki" className="text-sm text-primary hover:underline">
            위키 홈으로
          </Link>
        </div>

        <div className="divide-y divide-zinc-100 rounded-2xl bg-white overflow-hidden">
          {lots.map((lot) => (
            <Link
              key={lot.id}
              to="/wiki/$slug"
              params={{ slug: makeParkingSlug(lot.name, lot.id) }}
              className="flex items-center justify-between p-4 transition-colors hover:bg-zinc-50 active:bg-zinc-100"
            >
              <div className="min-w-0 flex-1">
                <div className="font-bold text-zinc-900 truncate">{lot.name}</div>
                <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <MapPin className="size-3" />
                  <span className="truncate">{lot.address}</span>
                </div>
              </div>
              <ChevronRight className="size-4 text-zinc-300" />
            </Link>
          ))}
        </div>

        {/* Pagination — 경계에선 링크 대신 비활성 span을 렌더해 page=0/초과 URL 방출 차단 */}
        <div className="mt-8 flex items-center justify-center gap-2">
          {hasPrev ? (
            <Link
              to="/wiki/all"
              search={(prev) => ({ ...prev, page: page - 1 })}
              aria-label="이전 페이지"
              className="flex size-10 items-center justify-center rounded-lg bg-white transition-colors hover:bg-zinc-100 active:bg-zinc-200"
            >
              <ChevronLeft className="size-4" />
            </Link>
          ) : (
            <span
              aria-hidden="true"
              className="flex size-10 cursor-not-allowed items-center justify-center rounded-lg bg-white opacity-50"
            >
              <ChevronLeft className="size-4" />
            </span>
          )}
          <span className="text-sm font-medium">
            {page} / {totalPages}
          </span>
          {hasNext ? (
            <Link
              to="/wiki/all"
              search={(prev) => ({ ...prev, page: page + 1 })}
              aria-label="다음 페이지"
              className="flex size-10 items-center justify-center rounded-lg bg-white transition-colors hover:bg-zinc-100 active:bg-zinc-200"
            >
              <ChevronRight className="size-4" />
            </Link>
          ) : (
            <span
              aria-hidden="true"
              className="flex size-10 cursor-not-allowed items-center justify-center rounded-lg bg-white opacity-50"
            >
              <ChevronRight className="size-4" />
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
