/**
 * 사이트맵 핸들러 — Worker에서 직접 D1 쿼리하여 XML 응답
 * TanStack Start의 서버 핸들러 문제(Content-Type 덮어쓰기, 동적 라우트 404) 우회
 *
 * sitemap-parking.xml : GSC 재등록용 단순 urlset
 * sitemap-priority.xml: 우선 색인 대상 단순 urlset
 * sitemap-index.xml   : sitemap index 구조
 * sitemap-N.xml       : web_sources 있는 주차장
 *
 * lastmod 정책:
 *   - 각 lot 페이지: 데이터 변경일과 검증 가이드 콘텐츠 수정일의 MAX.
 *     매일 today로 찍지 않아 Google이 lastmod 신호를 신뢰하도록 한다.
 *   - 정적 페이지: 확인된 페이지 콘텐츠 변경일을 수동으로 갱신.
 *   - sitemap-index: 각 sub-sitemap의 MAX(lot updated_at).
 *
 * 참고: 상세페이지의 색인 게이트와 사이트맵의 SQL 포함 조건은 아직 동일하지 않다.
 *      PARK-3 감사 결과를 바탕으로 대량 URL 제외 없이 별도 정합성 검토가 필요하다.
 */

import { PARKING_REGIONS } from '@/lib/parking-regions'
import { getVerifiedParkingGuide } from '@/lib/verified-parking-guides'

const URLS_PER_SITEMAP = 5000
const BASE = 'https://easy-parking.xyz'
// DB 행의 변경일이 없을 때만 쓰는 fallback. 정적 URL은 각각 확인된 변경일을 사용한다.
const STATIC_LASTMOD = '2026-08-03'
const HOME_LASTMOD = '2026-10-01'
const WIKI_ALL_LASTMOD = '2026-09-09'
const REGION_HUB_LASTMOD = '2026-09-30'

function toSlug(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[/\\?#%&=+]/g, '')
}

function makeParkingSlug(name: string, id: string): string {
  return `${toSlug(name)}-${id}`
}

/** ISO datetime 또는 date string에서 YYYY-MM-DD만 추출. null/invalid면 fallback. */
function toLastmodDate(raw: string | null | undefined, fallback: string): string {
  if (!raw) return fallback
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/)
  return match ? match[1] : fallback
}

function xmlResponse(xml: string): Response {
  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  })
}

/**
 * 사이트맵 인덱스용 메타데이터.
 * web_sources 있는 lot 전체에서 MAX(updated_at)과 개수를 한 번에 계산.
 * sub-sitemap 단위 lastmod은 batch crawl 특성상 거의 동일하므로 동일 값 사용.
 * D1에서 윈도우 함수 + GROUP BY 조합은 불안정 — 단순 집계로 처리.
 */
async function getSitemapIndexMeta(db: D1Database): Promise<{
  pageCount: number
  lastmod: string
}> {
  const row = await db
    .prepare(
      `SELECT
         COUNT(DISTINCT p.id) AS lot_count,
         MAX(
           COALESCE(
             CASE WHEN s.computed_at > p.updated_at THEN s.computed_at ELSE p.updated_at END,
             p.updated_at
           )
         ) AS last_updated
       FROM parking_lots p
       LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
       WHERE EXISTS (SELECT 1 FROM web_sources ws WHERE ws.parking_lot_id = p.id
                      -- 정보 모음 사이트(경쟁사) 행만 있는 lot 3,017곳이 '콘텐츠 있는 주차장'으로
                      -- 잡혀 thin 제외 규칙(#126)을 우회하고 있었다.
                      AND ws.filter_passed_v2 IS NOT 0)
          OR s.ai_summary IS NOT NULL
          OR p.curation_reason IS NOT NULL
          OR (
            (CASE WHEN p.total_spaces > 0 THEN 1 ELSE 0 END) +
            (CASE WHEN p.phone IS NOT NULL AND p.phone != '' THEN 1 ELSE 0 END) +
            (CASE WHEN p.is_free IS NOT NULL THEN 1 ELSE 0 END) +
            (CASE WHEN p.curation_tag IS NOT NULL THEN 1 ELSE 0 END)
          ) >= 3`,
    )
    .first<{ lot_count: number; last_updated: string | null }>()

  return {
    pageCount: Math.ceil((row?.lot_count ?? 0) / URLS_PER_SITEMAP),
    lastmod: toLastmodDate(row?.last_updated, STATIC_LASTMOD),
  }
}

async function sitemapIndex(db: D1Database): Promise<Response> {
  const meta = await getSitemapIndexMeta(db)

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>${BASE}/sitemap-static.xml</loc>
    <lastmod>${HOME_LASTMOD}</lastmod>
  </sitemap>`

  for (let i = 0; i < meta.pageCount; i++) {
    xml += `
  <sitemap>
    <loc>${BASE}/sitemap-${i}.xml</loc>
    <lastmod>${meta.lastmod}</lastmod>
  </sitemap>`
  }

  // 목적지 페이지(#166)는 별도 파일이다. 색인률을 따로 관측해야 되돌릴지 판단할 수 있다.
  // 쿼리는 작은 테이블 집계 하나뿐이어야 한다 — 이 인덱스는 콜드 응답이 이미 느리다(#161).
  const near = await db
    .prepare(`SELECT COUNT(*) AS c, MAX(updated_at) AS m FROM destinations`)
    .first<{ c: number; m: string | null }>()
  if ((near?.c ?? 0) > 0) {
    xml += `
  <sitemap>
    <loc>${BASE}/sitemap-near.xml</loc>
    <lastmod>${toLastmodDate(near?.m, STATIC_LASTMOD)}</lastmod>
  </sitemap>`
  }

  xml += `
</sitemapindex>`

  return xmlResponse(xml)
}

/**
 * /sitemap-near.xml : 목적지 페이지 (#166). 행이 있으면 발행이므로 조건이 없다.
 * 5,000건을 넘기 전까지 분할하지 않는다.
 */
async function sitemapNear(db: D1Database): Promise<Response> {
  const { results } = await db
    .prepare(`SELECT slug, updated_at FROM destinations ORDER BY id`)
    .all<{ slug: string; updated_at: string | null }>()
  const entries = results
    .map(
      (r) => `  <url>
    <loc>${BASE}/near/${encodeURI(r.slug)}</loc>
    <lastmod>${toLastmodDate(r.updated_at, STATIC_LASTMOD)}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>`,
    )
    .join('\n')
  return xmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</urlset>`)
}

/**
 * /sitemap-parking.xml : GSC 재등록용 새 진입점.
 *
 * 형식: 단순 urlset (sitemapindex 아님).
 * GSC가 과거 sitemapindex 형식을 잘 처리하지 못한 이력 회피.
 * 작은 단순 urlset이 fetch/파싱 부담이 가장 적어 "사이트맵을 읽을 수 없음" 패턴도 피한다.
 *
 * 콘텐츠: thin content 필터에 안 걸릴 lot — ai_summary 있거나 user_review 있는 곳만.
 * 약 100개 규모. 색인 검증된 후 점진 확장.
 */
async function sitemapParking(db: D1Database): Promise<Response> {
  const rows = await db
    .prepare(
      `SELECT p.id, p.name,
              COALESCE(
                CASE WHEN s.computed_at > p.updated_at THEN s.computed_at ELSE p.updated_at END,
                p.updated_at
              ) AS updated_at
       FROM parking_lots p
       INNER JOIN parking_lot_stats s ON s.parking_lot_id = p.id
       WHERE s.ai_summary IS NOT NULL OR COALESCE(s.review_count, 0) > 0
       ORDER BY
         CASE WHEN s.ai_summary IS NOT NULL THEN 1 ELSE 0 END DESC,
         COALESCE(s.review_count, 0) DESC,
         COALESCE(s.final_score, 0) DESC,
         p.id`,
    )
    .all<LotRow>()

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${staticUrlEntries()}`

  for (const row of rows.results ?? []) {
    xml += `
${parkingUrlEntry(row.id, row.name, row.updated_at, '0.9')}`
  }

  xml += `
</urlset>`

  return xmlResponse(xml)
}

function staticUrlEntries(): string {
  const fixed = `  <url>
    <loc>${BASE}/</loc>
    <lastmod>${HOME_LASTMOD}</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>${BASE}/wiki</loc>
    <lastmod>2026-09-30</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>${BASE}/wiki/all</loc>
    <lastmod>${WIKI_ALL_LASTMOD}</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.8</priority>
  </url>`

  // 지역 허브: /wiki/region/<label>. 인코딩은 region.$region.tsx의 canonical과 일치.
  const regionEntries = PARKING_REGIONS.map(
    (region) => `  <url>
    <loc>${BASE}/wiki/region/${encodeURIComponent(region.label)}</loc>
    <lastmod>${REGION_HUB_LASTMOD}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>`,
  ).join('\n')

  return `${fixed}\n${regionEntries}`
}

function parkingUrlEntry(
  id: string,
  name: string,
  updatedAt: string | null,
  priority = '0.7',
): string {
  const slug = encodeURI(makeParkingSlug(name, id))
  const dataDate = toLastmodDate(updatedAt, STATIC_LASTMOD)
  const guideDate = getVerifiedParkingGuide(id)?.contentUpdatedAt
  const lastmod = guideDate && guideDate > dataDate ? guideDate : dataDate
  return `  <url>
    <loc>${BASE}/wiki/${slug}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>${priority}</priority>
  </url>`
}

interface LotRow {
  id: string
  name: string
  updated_at: string | null
}

async function getPriorityParkingRows(db: D1Database, limit: number): Promise<LotRow[]> {
  const rows = await db
    .prepare(
      `SELECT p.id, p.name,
              COALESCE(
                CASE WHEN s.computed_at > p.updated_at THEN s.computed_at ELSE p.updated_at END,
                p.updated_at
              ) AS updated_at
       FROM parking_lots p
       LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
       WHERE p.curation_tag = 'easy'
          OR p.curation_reason IS NOT NULL
          OR s.ai_summary IS NOT NULL
          OR s.ai_tip_pricing IS NOT NULL
          OR s.ai_tip_visit IS NOT NULL
          OR s.ai_tip_alternative IS NOT NULL
          OR COALESCE(s.review_count, 0) > 0
          OR EXISTS (
            SELECT 1 FROM web_sources ws
            WHERE ws.parking_lot_id = p.id AND ws.relevance_score >= 40
              AND ws.filter_passed_v2 IS NOT 0
          )
       ORDER BY
         CASE WHEN p.curation_tag = 'easy' THEN 1 ELSE 0 END DESC,
         CASE
           WHEN s.ai_summary IS NOT NULL
             OR s.ai_tip_pricing IS NOT NULL
             OR s.ai_tip_visit IS NOT NULL
             OR s.ai_tip_alternative IS NOT NULL
           THEN 1 ELSE 0
         END DESC,
         COALESCE(s.review_count, 0) DESC,
         (SELECT COUNT(*) FROM web_sources ws
          WHERE ws.parking_lot_id = p.id AND ws.relevance_score >= 40
            AND ws.filter_passed_v2 IS NOT 0) DESC,
         COALESCE(s.final_score, 0) DESC,
         p.total_spaces DESC
       LIMIT ?`,
    )
    .bind(limit)
    .all<LotRow>()

  return rows.results ?? []
}

async function sitemapPriority(db: D1Database): Promise<Response> {
  const rows = await getPriorityParkingRows(db, 200)

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${staticUrlEntries()}`

  for (const row of rows) {
    xml += `
${parkingUrlEntry(row.id, row.name, row.updated_at, '0.8')}`
  }

  xml += `
</urlset>`

  return xmlResponse(xml)
}

async function sitemapStatic(): Promise<Response> {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${staticUrlEntries()}
</urlset>`

  return xmlResponse(xml)
}

/** 메인 사이트맵: web_sources 있는 주차장만 */
async function sitemapPage(db: D1Database, pageId: number): Promise<Response> {
  const offset = pageId * URLS_PER_SITEMAP
  const rows = await db
    .prepare(
      `SELECT DISTINCT p.id, p.name,
              COALESCE(
                CASE WHEN s.computed_at > p.updated_at THEN s.computed_at ELSE p.updated_at END,
                p.updated_at
              ) AS updated_at
       FROM parking_lots p
       LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
       WHERE EXISTS (SELECT 1 FROM web_sources ws WHERE ws.parking_lot_id = p.id
                      -- 정보 모음 사이트(경쟁사) 행만 있는 lot 3,017곳이 '콘텐츠 있는 주차장'으로
                      -- 잡혀 thin 제외 규칙(#126)을 우회하고 있었다.
                      AND ws.filter_passed_v2 IS NOT 0)
          OR s.ai_summary IS NOT NULL
          OR p.curation_reason IS NOT NULL
          OR (
            (CASE WHEN p.total_spaces > 0 THEN 1 ELSE 0 END) +
            (CASE WHEN p.phone IS NOT NULL AND p.phone != '' THEN 1 ELSE 0 END) +
            (CASE WHEN p.is_free IS NOT NULL THEN 1 ELSE 0 END) +
            (CASE WHEN p.curation_tag IS NOT NULL THEN 1 ELSE 0 END)
          ) >= 3
       ORDER BY p.id
       LIMIT ? OFFSET ?`,
    )
    .bind(URLS_PER_SITEMAP, offset)
    .all<LotRow>()

  if (!rows.results || rows.results.length === 0) {
    return new Response('Not Found', { status: 404 })
  }

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`

  for (const row of rows.results) {
    xml += `
${parkingUrlEntry(row.id, row.name, row.updated_at, '0.6')}`
  }

  xml += `
</urlset>`

  return xmlResponse(xml)
}

async function sitemapTest(db: D1Database): Promise<Response> {
  const rows = await db
    .prepare(`SELECT id, name, updated_at FROM parking_lots ORDER BY id LIMIT 10`)
    .all<LotRow>()

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`

  for (const row of rows.results ?? []) {
    xml += `
${parkingUrlEntry(row.id, row.name, row.updated_at, '0.6')}`
  }

  xml += `
</urlset>`

  return xmlResponse(xml)
}

export async function handleSitemap(pathname: string, db: D1Database): Promise<Response> {
  if (pathname === '/sitemap.xml') {
    return new Response(null, {
      status: 404,
      headers: {
        'Cache-Control': 'no-store',
      },
    })
  }

  if (pathname === '/sitemap-parking.xml') return sitemapParking(db)
  if (pathname === '/sitemap-index.xml') return sitemapIndex(db)
  if (pathname === '/sitemap-priority.xml') return sitemapPriority(db)
  if (pathname === '/sitemap-static.xml') return sitemapStatic()
  if (pathname === '/sitemap-near.xml') return sitemapNear(db)
  if (pathname === '/sitemap-test.xml') return sitemapTest(db)

  // /sitemap-0.xml, /sitemap-1.xml, ... (web_sources 있는 것)
  const mainMatch = pathname.match(/^\/sitemap-(\d+)\.xml$/)
  if (mainMatch) {
    const id = parseInt(mainMatch[1], 10)
    if (id >= 0 && id <= 999) return sitemapPage(db, id)
  }

  return new Response('Not Found', { status: 404 })
}
