/**
 * Technical SEO audit for easy-parking.
 *
 * Usage:
 *   bun run seo-audit --limit=100
 *   bun run seo-audit --url=https://easy-parking.xyz/wiki/스타필드시티-위례-주차장-KA-1935812519
 *   bun run seo-audit --skip-db --limit=100
 *   bun run seo-audit --remote --limit=100
 *   bun run seo-audit --strict --json=data/seo-audit.json
 */
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as cheerio from 'cheerio'
import { makeParkingSlug, parseIdFromSlug } from '../src/lib/slug'
import { d1Query, isRemote } from './lib/d1'

const args = process.argv.slice(2)
const BASE = argValue('--base') ?? 'https://easy-parking.xyz'
const LIMIT = intArg('--limit', 100)
const CONCURRENCY = intArg('--concurrency', 6)
const STRICT = args.includes('--strict')
const SKIP_DB = args.includes('--skip-db')
const JSON_OUT = argValue('--json')
const SINGLE_URLS = args
  .filter((a) => a.startsWith('--url='))
  .map((a) => normalizeUrl(a.split('=').slice(1).join('='), BASE))

type Severity = 'error' | 'warning'
type Scope = 'robots' | 'sitemap' | 'page' | 'db'

interface Issue {
  severity: Severity
  scope: Scope
  code: string
  message: string
  url?: string
  detail?: Record<string, unknown>
}

interface PageAudit {
  url: string
  finalUrl: string
  status: number
  title: string
  description: string
  h1: string[]
  canonical?: string
  metaRobots?: string
  xRobots?: string
  bodyTextLength: number
  internalLinks: number
  externalLinks: number
  jsonLdBlocks: number
  indexPotential: IndexPotential
  issues: Issue[]
}

interface IndexPotential {
  score: number
  band: 'strong' | 'moderate' | 'weak' | 'poor'
  signals: Record<string, boolean | number | string>
}

interface DbLot {
  id: string
  name: string
  address: string
  total_spaces: number
  curation_reason: string | null
  notes: string | null
  web_source_count: number
  high_source_count: number
  review_count: number
}

interface DbSignals {
  id: string
  name: string
  webSourceCount: number
  highSourceCount: number
  reviewCount: number
  hasStructuredValue: boolean
}

interface AuditReport {
  generatedAt: string
  base: string
  mode: 'sitemap' | 'single-url'
  limits: {
    limit: number
    concurrency: number
  }
  counts: {
    sitemapUrls: number
    auditedPages: number
    errors: number
    warnings: number
  }
  issues: Issue[]
  pages: PageAudit[]
}

function argValue(name: string): string | undefined {
  return args
    .find((a) => a.startsWith(`${name}=`))
    ?.split('=')
    .slice(1)
    .join('=')
}

function intArg(name: string, fallback: number): number {
  const raw = argValue(name)
  if (!raw) return fallback
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function issue(
  severity: Severity,
  scope: Scope,
  code: string,
  message: string,
  url?: string,
  detail?: Record<string, unknown>,
): Issue {
  return { severity, scope, code, message, url, detail }
}

function normalizeUrl(raw: string, base = BASE): string {
  const url = new URL(raw, base)
  url.hash = ''
  if (url.pathname !== '/' && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.slice(0, -1)
  }
  return url.href
}

function hostOf(raw: string): string {
  return new URL(raw).host
}

function textOf($: cheerio.CheerioAPI, selector: string): string {
  return $(selector).first().text().replace(/\s+/g, ' ').trim()
}

async function fetchText(
  url: string,
): Promise<{ url: string; status: number; text: string; headers: Headers }> {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': 'easy-parking-seo-audit/1.0 (+https://easy-parking.xyz)',
      Accept: 'text/html,application/xhtml+xml,application/xml,text/xml,*/*;q=0.8',
    },
  })
  return {
    url: res.url,
    status: res.status,
    text: await res.text(),
    headers: res.headers,
  }
}

async function auditRobots(base: string): Promise<Issue[]> {
  const url = new URL('/robots.txt', base).href
  try {
    const res = await fetchText(url)
    const issues: Issue[] = []
    if (res.status !== 200) {
      issues.push(
        issue('error', 'robots', 'ROBOTS_STATUS', `robots.txt returned ${res.status}`, url),
      )
      return issues
    }
    const expectedSitemaps = [
      new URL('/sitemap-parking.xml', base).href,
      new URL('/sitemap-priority.xml', base).href,
      new URL('/sitemap-index.xml', base).href,
    ]
    const declaredSitemaps = new Set(
      res.text
        .split(/\r?\n/)
        .map((line) => line.trim().toLowerCase())
        .filter((line) => line.startsWith('sitemap: ')),
    )
    const missingSitemaps = expectedSitemaps.filter(
      (sitemap) => !declaredSitemaps.has(`sitemap: ${sitemap}`.toLowerCase()),
    )
    const hasLegacySitemap = res.text
      .split(/\r?\n/)
      .some(
        (line) =>
          line.trim().toLowerCase() ===
          `sitemap: ${new URL('/sitemap.xml', base).href}`.toLowerCase(),
      )
    if (missingSitemaps.length > 0) {
      issues.push(
        issue(
          'warning',
          'robots',
          'ROBOTS_SITEMAP_MISSING',
          'robots.txt does not declare expected sitemaps',
          url,
          {
            expected: expectedSitemaps,
            missing: missingSitemaps,
          },
        ),
      )
    }
    if (hasLegacySitemap) {
      issues.push(
        issue(
          'warning',
          'robots',
          'ROBOTS_LEGACY_SITEMAP_DECLARED',
          'robots.txt still declares retired sitemap.xml',
          url,
          {
            retired: new URL('/sitemap.xml', base).href,
          },
        ),
      )
    }
    return issues
  } catch (error) {
    return [
      issue('error', 'robots', 'ROBOTS_FETCH_FAILED', 'failed to fetch robots.txt', url, {
        error: String(error),
      }),
    ]
  }
}

function parseXmlLocs(xml: string, tagName: 'sitemap' | 'url'): string[] {
  const $ = cheerio.load(xml, { xmlMode: true })
  return $(tagName)
    .map((_, el) => $(el).find('loc').first().text().trim())
    .get()
    .filter(Boolean)
}

async function collectSitemapUrls(base: string): Promise<{ urls: string[]; issues: Issue[] }> {
  const sitemapUrl = new URL('/sitemap-index.xml', base).href
  const issues: Issue[] = []
  const urls: string[] = []

  try {
    const index = await fetchText(sitemapUrl)
    if (index.status !== 200) {
      return {
        urls,
        issues: [
          issue(
            'error',
            'sitemap',
            'SITEMAP_INDEX_STATUS',
            `sitemap-index.xml returned ${index.status}`,
            sitemapUrl,
          ),
        ],
      }
    }

    const childSitemaps = parseXmlLocs(index.text, 'sitemap')
    if (childSitemaps.length === 0) {
      return {
        urls,
        issues: [
          issue(
            'error',
            'sitemap',
            'SITEMAP_INDEX_EMPTY',
            'sitemap-index.xml has no child sitemaps',
            sitemapUrl,
          ),
        ],
      }
    }

    for (const child of childSitemaps) {
      const normalizedChild = normalizeUrl(child, base)
      if (hostOf(normalizedChild) !== hostOf(base)) {
        issues.push(
          issue(
            'error',
            'sitemap',
            'SITEMAP_HOST_DRIFT',
            'child sitemap is on a different host',
            normalizedChild,
          ),
        )
        continue
      }
      const childRes = await fetchText(normalizedChild)
      if (childRes.status !== 200) {
        issues.push(
          issue(
            'error',
            'sitemap',
            'SITEMAP_CHILD_STATUS',
            `child sitemap returned ${childRes.status}`,
            normalizedChild,
          ),
        )
        continue
      }
      const childUrls = parseXmlLocs(childRes.text, 'url').map((u) => normalizeUrl(u, base))
      urls.push(...childUrls)
    }
  } catch (error) {
    issues.push(
      issue(
        'error',
        'sitemap',
        'SITEMAP_FETCH_FAILED',
        'failed to fetch or parse sitemap',
        sitemapUrl,
        {
          error: String(error),
        },
      ),
    )
  }

  return { urls: Array.from(new Set(urls)), issues }
}

async function mapLimit<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0

  async function run(): Promise<void> {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await worker(items[index], index)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => run()))
  return results
}

function isNoindex(value?: string): boolean {
  return Boolean(
    value
      ?.toLowerCase()
      .split(',')
      .map((v) => v.trim())
      .includes('noindex'),
  )
}

function scoreBand(score: number): IndexPotential['band'] {
  if (score >= 80) return 'strong'
  if (score >= 60) return 'moderate'
  if (score >= 40) return 'weak'
  return 'poor'
}

function computeIndexPotential(input: {
  url: string
  status: number
  canonical?: string
  metaRobots?: string
  xRobots?: string
  title: string
  description: string
  h1Count: number
  bodyTextLength: number
  internalLinks: number
  jsonLdBlocks: number
  linkedFromWikiHome: boolean
  inSitemap: boolean
  db?: DbSignals
}): IndexPotential {
  const canonicalSelf = input.canonical === normalizeUrl(input.url)
  const indexable =
    input.status === 200 &&
    !isNoindex(input.metaRobots) &&
    !isNoindex(input.xRobots) &&
    canonicalSelf
  const strongBody = input.bodyTextLength >= 1800
  const acceptableBody = input.bodyTextLength >= 900
  const usefulDescription = input.description.length >= 45
  const usefulTitle = input.title.length >= 12
  const hasEvidence = Boolean(
    input.db && (input.db.webSourceCount >= 3 || input.db.reviewCount >= 1),
  )
  const strongEvidence = Boolean(
    input.db && (input.db.highSourceCount >= 1 || input.db.webSourceCount >= 10),
  )
  const hasDbStructuredValue = Boolean(input.db?.hasStructuredValue)

  let score = 0
  if (input.inSitemap) score += 10
  if (input.linkedFromWikiHome) score += 10
  if (input.status === 200) score += 10
  if (!isNoindex(input.metaRobots) && !isNoindex(input.xRobots)) score += 10
  if (canonicalSelf) score += 10
  if (usefulTitle) score += 6
  if (usefulDescription) score += 6
  if (input.h1Count > 0) score += 5
  if (strongBody) score += 12
  else if (acceptableBody) score += 7
  if (input.jsonLdBlocks > 0) score += 6
  if (input.internalLinks >= 10) score += 5
  else if (input.internalLinks >= 5) score += 3
  if (hasDbStructuredValue) score += 5
  if (hasEvidence) score += 5
  if (strongEvidence) score += 5

  if (!indexable) score = Math.min(score, 39)

  return {
    score: Math.min(100, score),
    band: scoreBand(Math.min(100, score)),
    signals: {
      inSitemap: input.inSitemap,
      linkedFromWikiHome: input.linkedFromWikiHome,
      status: input.status,
      canonicalSelf,
      indexable,
      titleLength: input.title.length,
      descriptionLength: input.description.length,
      h1Count: input.h1Count,
      bodyTextLength: input.bodyTextLength,
      internalLinks: input.internalLinks,
      jsonLdBlocks: input.jsonLdBlocks,
      dbLotId: input.db?.id ?? '',
      webSourceCount: input.db?.webSourceCount ?? 0,
      highSourceCount: input.db?.highSourceCount ?? 0,
      reviewCount: input.db?.reviewCount ?? 0,
      hasStructuredValue: hasDbStructuredValue,
    },
  }
}

function analyzeHtml(
  url: string,
  fetchResult: Awaited<ReturnType<typeof fetchText>>,
  context: { linkedFromWikiHome: boolean; inSitemap: boolean; db?: DbSignals },
): PageAudit {
  const pageIssues: Issue[] = []
  const finalUrl = normalizeUrl(fetchResult.url)
  const $ = cheerio.load(fetchResult.text)

  $('script, style, noscript, svg').remove()

  const title = textOf($, 'title')
  const description = $('meta[name="description"]').attr('content')?.trim() ?? ''
  const canonicalRaw = $('link[rel="canonical"]').attr('href')?.trim()
  const canonical = canonicalRaw ? normalizeUrl(canonicalRaw, finalUrl) : undefined
  const metaRobots = $('meta[name="robots"]').attr('content')?.trim()
  const xRobots = fetchResult.headers.get('x-robots-tag')?.trim() ?? undefined
  const h1 = $('h1')
    .map((_, el) => $(el).text().replace(/\s+/g, ' ').trim())
    .get()
    .filter(Boolean)
  const bodyTextLength = $('body').text().replace(/\s+/g, ' ').trim().length
  const links = $('a[href]')
    .map((_, el) => $(el).attr('href')?.trim())
    .get()
    .filter(Boolean)
  const internalLinks = links.filter((href) => {
    try {
      return hostOf(normalizeUrl(href, finalUrl)) === hostOf(BASE)
    } catch {
      return false
    }
  }).length
  const externalLinks = links.length - internalLinks
  let jsonLdBlocks = 0

  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).html()?.trim()
    if (!raw) return
    jsonLdBlocks += 1
    try {
      JSON.parse(raw)
    } catch (error) {
      pageIssues.push(
        issue('warning', 'page', 'JSON_LD_INVALID', 'JSON-LD block is not valid JSON', url, {
          error: String(error),
        }),
      )
    }
  })

  if (fetchResult.status !== 200) {
    pageIssues.push(
      issue('error', 'page', 'PAGE_STATUS', `page returned ${fetchResult.status}`, url),
    )
  }
  if (hostOf(finalUrl) !== hostOf(BASE)) {
    pageIssues.push(
      issue(
        'error',
        'page',
        'FINAL_HOST_DRIFT',
        'final URL host differs from canonical base',
        url,
        { finalUrl },
      ),
    )
  }
  if (isNoindex(metaRobots)) {
    pageIssues.push(
      issue('error', 'page', 'META_NOINDEX', 'sitemap URL renders meta robots noindex', url, {
        metaRobots,
      }),
    )
  }
  if (isNoindex(xRobots)) {
    pageIssues.push(
      issue('error', 'page', 'X_ROBOTS_NOINDEX', 'sitemap URL has X-Robots-Tag noindex', url, {
        xRobots,
      }),
    )
  }
  if (!canonical) {
    pageIssues.push(issue('error', 'page', 'CANONICAL_MISSING', 'canonical link is missing', url))
  } else if (canonical !== normalizeUrl(url)) {
    pageIssues.push(
      issue('error', 'page', 'CANONICAL_MISMATCH', 'canonical does not match audited URL', url, {
        canonical,
      }),
    )
  }
  if (!title) {
    pageIssues.push(issue('warning', 'page', 'TITLE_MISSING', 'title is missing', url))
  } else if (title.length < 12) {
    pageIssues.push(
      issue('warning', 'page', 'TITLE_SHORT', 'title is very short', url, { length: title.length }),
    )
  }
  if (!description) {
    pageIssues.push(
      issue('warning', 'page', 'DESCRIPTION_MISSING', 'meta description is missing', url),
    )
  } else if (description.length < 35) {
    pageIssues.push(
      issue('warning', 'page', 'DESCRIPTION_SHORT', 'meta description is very short', url, {
        length: description.length,
      }),
    )
  }
  if (h1.length === 0) {
    pageIssues.push(issue('warning', 'page', 'H1_MISSING', 'h1 is missing', url))
  }
  if (bodyTextLength < 500) {
    pageIssues.push(
      issue('warning', 'page', 'BODY_TEXT_THIN', 'rendered body text is short', url, {
        bodyTextLength,
      }),
    )
  }
  if (internalLinks < 5) {
    pageIssues.push(
      issue('warning', 'page', 'INTERNAL_LINKS_LOW', 'page has very few internal links', url, {
        internalLinks,
      }),
    )
  }

  const indexPotential = computeIndexPotential({
    url,
    status: fetchResult.status,
    canonical,
    metaRobots,
    xRobots,
    title,
    description,
    h1Count: h1.length,
    bodyTextLength,
    internalLinks,
    jsonLdBlocks,
    linkedFromWikiHome: context.linkedFromWikiHome,
    inSitemap: context.inSitemap,
    db: context.db,
  })
  if (indexPotential.score < 60) {
    pageIssues.push(
      issue(
        'warning',
        'page',
        'INDEX_POTENTIAL_LOW',
        'page has weak index potential signals',
        url,
        {
          score: indexPotential.score,
          band: indexPotential.band,
        },
      ),
    )
  }

  return {
    url,
    finalUrl,
    status: fetchResult.status,
    title,
    description,
    h1,
    canonical,
    metaRobots,
    xRobots,
    bodyTextLength,
    internalLinks,
    externalLinks,
    jsonLdBlocks,
    indexPotential,
    issues: pageIssues,
  }
}

async function auditPage(
  url: string,
  context: { linkedFromWikiHome: boolean; inSitemap: boolean; db?: DbSignals },
): Promise<PageAudit> {
  try {
    const res = await fetchText(url)
    return analyzeHtml(url, res, context)
  } catch (error) {
    const pageIssue = issue('error', 'page', 'PAGE_FETCH_FAILED', 'failed to fetch page', url, {
      error: String(error),
    })
    return {
      url,
      finalUrl: url,
      status: 0,
      title: '',
      description: '',
      h1: [],
      bodyTextLength: 0,
      internalLinks: 0,
      externalLinks: 0,
      jsonLdBlocks: 0,
      indexPotential: {
        score: 0,
        band: 'poor',
        signals: {
          inSitemap: context.inSitemap,
          linkedFromWikiHome: context.linkedFromWikiHome,
          indexable: false,
        },
      },
      issues: [pageIssue],
    }
  }
}

function lotUrl(lot: { id: string; name: string }): string {
  return normalizeUrl(`/wiki/${encodeURI(makeParkingSlug(lot.name, lot.id))}`, BASE)
}

function loadDbSignals(): { issues: Issue[]; signalsByUrl: Map<string, DbSignals> } {
  const signalsByUrl = new Map<string, DbSignals>()
  if (SKIP_DB) return { issues: [], signalsByUrl }
  const issues: Issue[] = []

  try {
    const expectedLots = d1Query<DbLot>(`
      SELECT
        p.id,
        p.name,
        p.address,
        p.total_spaces,
        p.curation_reason,
        p.notes,
        COUNT(ws.id) AS web_source_count,
        SUM(CASE WHEN ws.relevance_score >= 70 THEN 1 ELSE 0 END) AS high_source_count,
        (SELECT COUNT(*) FROM user_reviews ur WHERE ur.parking_lot_id = p.id) AS review_count
      FROM parking_lots p
      JOIN web_sources ws ON ws.parking_lot_id = p.id
      GROUP BY p.id
      ORDER BY p.id
    `)

    for (const lot of expectedLots) {
      const url = lotUrl(lot)
      signalsByUrl.set(url, {
        id: lot.id,
        name: lot.name,
        webSourceCount: lot.web_source_count,
        highSourceCount: lot.high_source_count,
        reviewCount: lot.review_count,
        hasStructuredValue:
          lot.total_spaces > 0 ||
          Boolean(lot.curation_reason) ||
          Boolean(lot.notes) ||
          lot.review_count > 0,
      })
    }
  } catch (error) {
    issues.push(
      issue(
        'warning',
        'db',
        'DB_SIGNAL_LOAD_FAILED',
        'failed to load DB index potential signals',
        undefined,
        {
          mode: isRemote ? 'remote' : 'local',
          error: String(error),
        },
      ),
    )
  }

  return { issues, signalsByUrl }
}

function auditDbPolicy(sitemapUrls: Set<string>, signalsByUrl: Map<string, DbSignals>): Issue[] {
  if (SKIP_DB) return []
  const issues: Issue[] = []

  try {
    const expectedLots = d1Query<DbLot>(`
      SELECT
        p.id,
        p.name,
        p.address,
        p.total_spaces,
        p.curation_reason,
        p.notes,
        COUNT(ws.id) AS web_source_count,
        SUM(CASE WHEN ws.relevance_score >= 70 THEN 1 ELSE 0 END) AS high_source_count,
        (SELECT COUNT(*) FROM user_reviews ur WHERE ur.parking_lot_id = p.id) AS review_count
      FROM parking_lots p
      JOIN web_sources ws ON ws.parking_lot_id = p.id
      GROUP BY p.id
      ORDER BY p.id
    `)

    let missing = 0
    for (const lot of expectedLots) {
      const url = lotUrl(lot)
      if (!sitemapUrls.has(url)) {
        missing += 1
        if (missing <= 25) {
          issues.push(
            issue(
              'error',
              'db',
              'DB_EXPECTED_URL_MISSING_FROM_SITEMAP',
              'web_sources lot is missing from sitemap',
              url,
              {
                id: lot.id,
                name: lot.name,
                webSourceCount: lot.web_source_count,
              },
            ),
          )
        }
      }
    }
    if (missing > 25) {
      issues.push(
        issue(
          'error',
          'db',
          'DB_EXPECTED_URL_MISSING_FROM_SITEMAP_MORE',
          `${missing - 25} additional web_sources lots are missing from sitemap`,
        ),
      )
    }

    const expectedById = new Map(expectedLots.map((lot) => [lot.id, lot]))
    let sitemapWithoutSources = 0
    let weakCandidates = 0
    for (const url of sitemapUrls) {
      const id = parseIdFromSlug(decodeURIComponent(new URL(url).pathname.split('/').pop() ?? ''))
      if (!id || !url.includes('/wiki/')) continue
      const lot = expectedById.get(id)
      const dbSignal = signalsByUrl.get(url)
      if (!lot && !dbSignal) {
        sitemapWithoutSources += 1
        if (sitemapWithoutSources <= 25) {
          issues.push(
            issue(
              'error',
              'db',
              'SITEMAP_URL_WITHOUT_WEB_SOURCES',
              'sitemap includes a lot with no web_sources in DB',
              url,
              {
                id,
              },
            ),
          )
        }
        continue
      }

      const hasStructuredValue = dbSignal?.hasStructuredValue ?? false
      const highSourceCount = dbSignal?.highSourceCount ?? lot?.high_source_count ?? 0
      if (!hasStructuredValue && highSourceCount === 0) {
        weakCandidates += 1
        if (weakCandidates <= 25) {
          issues.push(
            issue(
              'warning',
              'db',
              'PARKING_THIN_CANDIDATE',
              'sitemap lot has weak structured/content signals',
              url,
              {
                id,
                name: dbSignal?.name ?? lot?.name,
                webSourceCount: dbSignal?.webSourceCount ?? lot?.web_source_count,
              },
            ),
          )
        }
      }
    }
    if (sitemapWithoutSources > 25) {
      issues.push(
        issue(
          'error',
          'db',
          'SITEMAP_URL_WITHOUT_WEB_SOURCES_MORE',
          `${sitemapWithoutSources - 25} additional sitemap URLs have no web_sources in DB`,
        ),
      )
    }
    if (weakCandidates > 25) {
      issues.push(
        issue(
          'warning',
          'db',
          'PARKING_THIN_CANDIDATE_MORE',
          `${weakCandidates - 25} additional sitemap lots have weak content signals`,
        ),
      )
    }

    const duplicates = d1Query<{ name: string; address: string; count: number; ids: string }>(`
      SELECT name, address, COUNT(*) AS count, GROUP_CONCAT(id) AS ids
      FROM parking_lots
      GROUP BY name, address
      HAVING COUNT(*) > 1
      ORDER BY count DESC
      LIMIT 25
    `)
    for (const duplicate of duplicates) {
      issues.push(
        issue(
          'warning',
          'db',
          'DUPLICATE_LOT_NAME_ADDRESS',
          'duplicate lot name/address may split canonical signals',
          undefined,
          duplicate,
        ),
      )
    }
  } catch (error) {
    issues.push(
      issue(
        'warning',
        'db',
        'DB_AUDIT_SKIPPED',
        'DB policy audit failed; rerun with --skip-db or check D1 state',
        undefined,
        {
          mode: isRemote ? 'remote' : 'local',
          error: String(error),
        },
      ),
    )
  }

  return issues
}

async function collectWikiHomeLinks(
  base: string,
): Promise<{ links: Set<string>; issues: Issue[] }> {
  const url = new URL('/wiki', base).href
  try {
    const res = await fetchText(url)
    if (res.status !== 200) {
      return {
        links: new Set(),
        issues: [issue('warning', 'page', 'WIKI_HOME_STATUS', `/wiki returned ${res.status}`, url)],
      }
    }
    const $ = cheerio.load(res.text)
    const links = new Set(
      $('a[href]')
        .map((_, el) => $(el).attr('href')?.trim())
        .get()
        .filter(Boolean)
        .map((href) => normalizeUrl(href, url))
        .filter((href) => hostOf(href) === hostOf(base)),
    )
    return { links, issues: [] }
  } catch (error) {
    return {
      links: new Set(),
      issues: [
        issue(
          'warning',
          'page',
          'WIKI_HOME_FETCH_FAILED',
          'failed to fetch /wiki for discovery signals',
          url,
          {
            error: String(error),
          },
        ),
      ],
    }
  }
}

function summarizeIssues(issues: Issue[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const item of issues) {
    counts.set(item.code, (counts.get(item.code) ?? 0) + 1)
  }
  return new Map([...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])))
}

function printReport(report: AuditReport): void {
  const avgIndexPotential =
    report.pages.length > 0
      ? Math.round(
          report.pages.reduce((sum, page) => sum + page.indexPotential.score, 0) /
            report.pages.length,
        )
      : 0
  const bandCounts = report.pages.reduce<Record<string, number>>((acc, page) => {
    acc[page.indexPotential.band] = (acc[page.indexPotential.band] ?? 0) + 1
    return acc
  }, {})

  console.log(`\n🔎 SEO audit — ${report.base}`)
  console.log(`   mode: ${report.mode}`)
  console.log(`   sitemap URLs: ${report.counts.sitemapUrls}`)
  console.log(`   audited pages: ${report.counts.auditedPages}`)
  console.log(`   errors: ${report.counts.errors}, warnings: ${report.counts.warnings}`)
  console.log(`   avg index potential: ${avgIndexPotential}/100`)
  console.log(
    `   bands: strong=${bandCounts.strong ?? 0}, moderate=${bandCounts.moderate ?? 0}, weak=${bandCounts.weak ?? 0}, poor=${bandCounts.poor ?? 0}`,
  )

  const counts = summarizeIssues(report.issues)
  if (counts.size > 0) {
    console.log(`\nTop issue codes:`)
    for (const [code, count] of [...counts.entries()].slice(0, 20)) {
      console.log(`   ${code}: ${count}`)
    }
  }

  const examples = report.issues.slice(0, 20)
  if (examples.length > 0) {
    console.log(`\nExamples:`)
    for (const item of examples) {
      const target = item.url ? ` ${item.url}` : ''
      console.log(`   [${item.severity}] ${item.code}:${target} — ${item.message}`)
    }
  }
}

async function main(): Promise<void> {
  const mode = SINGLE_URLS.length > 0 ? 'single-url' : 'sitemap'
  const setupIssues = await auditRobots(BASE)
  const sitemap = await collectSitemapUrls(BASE)
  const sitemapUrls = sitemap.urls
  const urlsToAudit = mode === 'sitemap' ? sitemapUrls.slice(0, LIMIT) : SINGLE_URLS
  const wikiHome = await collectWikiHomeLinks(BASE)
  const dbSignals = loadDbSignals()
  const sitemapUrlSet = new Set(sitemapUrls)

  const pages = await mapLimit(urlsToAudit, CONCURRENCY, (url) =>
    auditPage(url, {
      linkedFromWikiHome: wikiHome.links.has(url),
      inSitemap: sitemapUrlSet.has(url),
      db: dbSignals.signalsByUrl.get(url),
    }),
  )
  const dbIssues = mode === 'sitemap' ? auditDbPolicy(sitemapUrlSet, dbSignals.signalsByUrl) : []
  const issues = [
    ...setupIssues,
    ...sitemap.issues,
    ...wikiHome.issues,
    ...dbSignals.issues,
    ...pages.flatMap((page) => page.issues),
    ...dbIssues,
  ]
  const errors = issues.filter((item) => item.severity === 'error').length
  const warnings = issues.length - errors
  const report: AuditReport = {
    generatedAt: new Date().toISOString(),
    base: BASE,
    mode,
    limits: {
      limit: LIMIT,
      concurrency: CONCURRENCY,
    },
    counts: {
      sitemapUrls: sitemapUrls.length,
      auditedPages: pages.length,
      errors,
      warnings,
    },
    issues,
    pages,
  }

  printReport(report)

  if (JSON_OUT) {
    const outPath = resolve(import.meta.dir, '..', JSON_OUT)
    writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf-8')
    console.log(`\nWrote ${outPath}`)
  }

  if (STRICT && errors > 0) {
    process.exit(1)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
