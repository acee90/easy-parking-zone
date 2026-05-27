/**
 * 사이트맵 핸들러 — Worker에서 직접 D1 쿼리하여 XML 응답
 * TanStack Start의 서버 핸들러 문제(Content-Type 덮어쓰기, 동적 라우트 404) 우회
 *
 * sitemap-parking.xml : 신규 sitemap-index (GSC 재등록용, 모든 sub-sitemap 가리킴)
 * sitemap.xml         : 핵심 URL만 담은 단순 urlset (Google 재처리용 / legacy)
 * sitemap-index.xml   : 기존 sitemap index 구조 유지 (legacy)
 * sitemap-N.xml       : web_sources 있는 주차장
 *
 * lastmod 정책:
 *   - 각 lot 페이지: parking_lots.updated_at / parking_lot_stats.computed_at의 MAX (실제 데이터 변경일).
 *     매일 today로 찍지 않아 Google이 lastmod 신호를 신뢰하도록 한다.
 *   - 정적 페이지(/, /wiki): 빌드 시점 기반의 안정적 날짜.
 *   - sitemap-index: 각 sub-sitemap의 MAX(lot updated_at).
 *
 * 참고: web_sources 없는 thin 주차장은 sitemap에서 완전 제외 (#126).
 *      해당 페이지는 wiki/$slug.tsx에서 noindex 메타로 색인 차단.
 */

const URLS_PER_SITEMAP = 5000
const BASE = 'https://easy-parking.xyz'
// 정적 페이지(/, /wiki)의 lastmod 기준일. 콘텐츠 구조가 바뀔 때 수동으로 갱신.
const STATIC_LASTMOD = '2026-05-27'

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
       INNER JOIN web_sources w ON w.parking_lot_id = p.id
       LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id`,
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
    <lastmod>${STATIC_LASTMOD}</lastmod>
  </sitemap>`

  for (let i = 0; i < meta.pageCount; i++) {
    xml += `
  <sitemap>
    <loc>${BASE}/sitemap-${i}.xml</loc>
    <lastmod>${meta.lastmod}</lastmod>
  </sitemap>`
  }

  xml += `
</sitemapindex>`

  return xmlResponse(xml)
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
${staticUrlEntries(STATIC_LASTMOD)}`

  for (const row of rows.results ?? []) {
    xml += `
${parkingUrlEntry(row.id, row.name, row.updated_at, '0.9')}`
  }

  xml += `
</urlset>`

  return xmlResponse(xml)
}

function staticUrlEntries(now: string): string {
  return `  <url>
    <loc>${BASE}/</loc>
    <lastmod>${now}</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>${BASE}/wiki</loc>
    <lastmod>${now}</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.9</priority>
  </url>`
}

function parkingUrlEntry(
  id: string,
  name: string,
  updatedAt: string | null,
  priority = '0.7',
): string {
  const slug = encodeURI(makeParkingSlug(name, id))
  const lastmod = toLastmodDate(updatedAt, STATIC_LASTMOD)
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
          WHERE ws.parking_lot_id = p.id AND ws.relevance_score >= 40) DESC,
         COALESCE(s.final_score, 0) DESC,
         p.total_spaces DESC
       LIMIT ?`,
    )
    .bind(limit)
    .all<LotRow>()

  return rows.results ?? []
}

async function sitemapMain(db: D1Database): Promise<Response> {
  const rows = await getPriorityParkingRows(db, 1000)

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${staticUrlEntries(STATIC_LASTMOD)}`

  for (const row of rows) {
    xml += `
${parkingUrlEntry(row.id, row.name, row.updated_at, '0.8')}`
  }

  xml += `
</urlset>`

  return xmlResponse(xml)
}

async function sitemapPriority(db: D1Database): Promise<Response> {
  const rows = await getPriorityParkingRows(db, 200)

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${staticUrlEntries(STATIC_LASTMOD)}`

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
${staticUrlEntries(STATIC_LASTMOD)}
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
       INNER JOIN web_sources w ON w.parking_lot_id = p.id
       LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
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
  if (pathname === '/sitemap-parking.xml') return sitemapParking(db)
  if (pathname === '/sitemap.xml') return sitemapMain(db)
  if (pathname === '/sitemap-index.xml') return sitemapIndex(db)
  if (pathname === '/sitemap-priority.xml') return sitemapPriority(db)
  if (pathname === '/sitemap-static.xml') return sitemapStatic()
  if (pathname === '/sitemap-test.xml') return sitemapTest(db)

  // /sitemap-0.xml, /sitemap-1.xml, ... (web_sources 있는 것)
  const mainMatch = pathname.match(/^\/sitemap-(\d+)\.xml$/)
  if (mainMatch) {
    const id = parseInt(mainMatch[1], 10)
    if (id >= 0 && id <= 999) return sitemapPage(db, id)
  }

  return new Response('Not Found', { status: 404 })
}
