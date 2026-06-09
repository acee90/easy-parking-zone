import { createFileRoute, Link } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { ChevronLeft, ChevronRight, MapPin } from 'lucide-react'
import { z } from 'zod'
import { getDb } from '@/db'
import { makeParkingSlug } from '@/lib/slug'
import { type ParkingLotRow, rowToParkingLot } from '@/server/transforms'
import type { ParkingLot } from '@/types/parking'

const allLotsSearchSchema = z.object({
  // page=0/음수는 min(1) 실패 → catch(1)로 보정 (OFFSET 음수/크롤 트랩 방지)
  page: z.number().int().min(1).catch(1),
  region: z.string().optional(),
})

const PAGE_SIZE = 100
const SITE_BASE = 'https://easy-parking.xyz'

/** 지역·페이지별 self-canonical URL. page=1은 쿼리 생략. */
function buildAllLotsCanonical(region: string | undefined, page: number): string {
  const params = new URLSearchParams()
  if (region) params.set('region', region)
  if (page > 1) params.set('page', String(page))
  const qs = params.toString()
  return qs ? `${SITE_BASE}/wiki/all?${qs}` : `${SITE_BASE}/wiki/all`
}

function buildAllLotsTitle(region: string | undefined, page: number): string {
  const base = region ? `${region} 주차장 목록` : '전체 주차장 목록'
  const paged = page > 1 ? `${base} (${page}페이지)` : base
  return `${paged} | 쉬운주차장`
}

function buildAllLotsDescription(region: string | undefined): string {
  return region
    ? `${region} 지역 주차장의 요금·운영시간·주차 난이도를 한 곳에서 비교하세요.`
    : '전국 주차장의 요금·운영시간·주차 난이도를 한 곳에서 비교하세요.'
}

const fetchAllLots = createServerFn({ method: 'GET' })
  .inputValidator((data: unknown) => allLotsSearchSchema.parse(data))
  .handler(async ({ data: { page, region } }) => {
    const db = getDb()
    const offset = (page - 1) * PAGE_SIZE

    let query = `
      SELECT p.*,
        s.final_score as avg_score,
        COALESCE(s.review_count, 0) as review_count,
        s.reliability
      FROM parking_lots p
      LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
    `
    const params: any[] = []

    if (region) {
      query += ` WHERE p.address LIKE ?`
      params.push(`${region}%`)
    }

    query += ` ORDER BY COALESCE(s.final_score, 0) DESC, p.total_spaces DESC LIMIT ? OFFSET ?`
    params.push(PAGE_SIZE, offset)

    const rows = await db.all(query, ...params)

    const countQuery = region
      ? `SELECT COUNT(*) as count FROM parking_lots WHERE address LIKE ?`
      : `SELECT COUNT(*) as count FROM parking_lots`
    const countResult = await db.get(countQuery, ...(region ? [`${region}%`] : []))
    const totalCount = (countResult as any).count

    return {
      lots: (rows as unknown as ParkingLotRow[]).map(rowToParkingLot),
      totalCount,
      page,
      pageSize: PAGE_SIZE,
      region,
    }
  })

export const Route = createFileRoute('/wiki/all')({
  validateSearch: (search) => allLotsSearchSchema.parse(search),
  loaderDeps: ({ search: { page, region } }) => ({ page, region }),
  loader: ({ deps }) => fetchAllLots({ data: deps }),
  head: ({ loaderData }) => {
    const region = loaderData?.region
    const page = loaderData?.page ?? 1
    const title = buildAllLotsTitle(region, page)
    const description = buildAllLotsDescription(region)
    // 1페이지(전체/지역 허브)는 색인, 2페이지 이상은 thin 중복 방지로 noindex.
    // follow는 유지해 상세 페이지 링크는 계속 크롤되게 한다.
    const robots =
      page > 1
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
        { property: 'og:url', content: buildAllLotsCanonical(region, page) },
      ],
    }
  },
  component: AllLotsPage,
})

function AllLotsPage() {
  const { lots, totalCount, page, pageSize, region } = Route.useLoaderData()
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize))
  const hasPrev = page > 1
  const hasNext = page < totalPages
  // head links가 SSR 직렬화되지 않아 canonical은 React 19 metadata hoisting으로 렌더.
  const canonicalUrl = buildAllLotsCanonical(region, page)

  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <link rel="canonical" href={canonicalUrl} />
      <div className="mx-auto max-w-4xl px-4">
        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold">
              {region ? `${region} 주차장` : '전체 주차장 목록'}
            </h1>
            <p className="text-sm text-muted-foreground">
              총 {totalCount.toLocaleString()}개의 주차장 정보가 있습니다.
            </p>
          </div>
          <Link to="/wiki" className="text-sm text-blue-500 hover:underline">
            위키 홈으로
          </Link>
        </div>

        <div className="divide-y rounded-xl border bg-white overflow-hidden shadow-sm">
          {lots.map((lot) => (
            <Link
              key={lot.id}
              to="/wiki/$slug"
              params={{ slug: makeParkingSlug(lot.name, lot.id) }}
              className="flex items-center justify-between p-4 hover:bg-gray-50 transition-colors"
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
              className="flex size-10 items-center justify-center rounded-lg border bg-white shadow-sm transition-colors hover:bg-gray-50"
            >
              <ChevronLeft className="size-4" />
            </Link>
          ) : (
            <span
              aria-hidden="true"
              className="flex size-10 cursor-not-allowed items-center justify-center rounded-lg border bg-white opacity-50 shadow-sm"
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
              className="flex size-10 items-center justify-center rounded-lg border bg-white shadow-sm transition-colors hover:bg-gray-50"
            >
              <ChevronRight className="size-4" />
            </Link>
          ) : (
            <span
              aria-hidden="true"
              className="flex size-10 cursor-not-allowed items-center justify-center rounded-lg border bg-white opacity-50 shadow-sm"
            >
              <ChevronRight className="size-4" />
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
