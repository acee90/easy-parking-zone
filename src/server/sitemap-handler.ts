/**
 * 사이트맵 핸들러 — Worker에서 직접 D1 쿼리하여 XML 응답
 * TanStack Start의 서버 핸들러 문제(Content-Type 덮어쓰기, 동적 라우트 404) 우회
 */

const URLS_PER_SITEMAP = 5000
const BASE = 'https://easy-parking.xyz'

function toSlug(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[/\\?#%&=+]/g, '')
}

function makeParkingSlug(name: string, id: string): string {
  return `${toSlug(name)}-${id}`
}

function xmlResponse(xml: string): Response {
  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    },
  })
}

async function sitemapIndex(db: D1Database): Promise<Response> {
  const result = await db
    .prepare('SELECT COUNT(*) as count FROM parking_lots')
    .first<{ count: number }>()
  const totalPages = Math.ceil((result?.count ?? 0) / URLS_PER_SITEMAP)
  const now = new Date().toISOString().split('T')[0]

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>${BASE}/sitemap-static.xml</loc>
    <lastmod>${now}</lastmod>
  </sitemap>`

  for (let i = 0; i < totalPages; i++) {
    xml += `
  <sitemap>
    <loc>${BASE}/sitemap-${i}.xml</loc>
    <lastmod>${now}</lastmod>
  </sitemap>`
  }

  xml += `
</sitemapindex>`

  return xmlResponse(xml)
}

async function sitemapStatic(): Promise<Response> {
  const now = new Date().toISOString().split('T')[0]
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
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
  </url>
</urlset>`

  return xmlResponse(xml)
}

async function sitemapPage(db: D1Database, pageId: number): Promise<Response> {
  const offset = pageId * URLS_PER_SITEMAP
  const rows = await db
    .prepare('SELECT id, name FROM parking_lots ORDER BY id LIMIT ? OFFSET ?')
    .bind(URLS_PER_SITEMAP, offset)
    .all<{ id: string; name: string }>()

  if (!rows.results || rows.results.length === 0) {
    return new Response('Not Found', { status: 404 })
  }

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`

  for (const row of rows.results) {
    const slug = encodeURI(makeParkingSlug(row.name, row.id))
    xml += `
  <url>
    <loc>${BASE}/wiki/${slug}</loc>
    <changefreq>weekly</changefreq>
    <priority>0.6</priority>
  </url>`
  }

  xml += `
</urlset>`

  return xmlResponse(xml)
}

async function sitemapTest(db: D1Database): Promise<Response> {
  const rows = await db
    .prepare('SELECT id, name FROM parking_lots ORDER BY id LIMIT 10')
    .all<{ id: string; name: string }>()

  const now = new Date().toISOString().split('T')[0]
  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`

  for (const row of rows.results) {
    const slug = encodeURI(makeParkingSlug(row.name, row.id))
    xml += `
  <url>
    <loc>${BASE}/wiki/${slug}</loc>
    <lastmod>${now}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.6</priority>
  </url>`
  }

  xml += `
</urlset>`

  return xmlResponse(xml)
}

export async function handleSitemap(pathname: string, db: D1Database): Promise<Response> {
  if (pathname === '/sitemap.xml') return sitemapIndex(db)
  if (pathname === '/sitemap-static.xml') return sitemapStatic()
  if (pathname === '/sitemap-test.xml') return sitemapTest(db)

  // /sitemap-0.xml, /sitemap-1.xml, ...
  const match = pathname.match(/^\/sitemap-(\d+)\.xml$/)
  if (match) {
    const id = parseInt(match[1], 10)
    if (id >= 0 && id <= 999) return sitemapPage(db, id)
  }

  return new Response('Not Found', { status: 404 })
}
