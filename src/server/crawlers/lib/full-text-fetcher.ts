/**
 * Full-text fetcher — extracts the body text from a blog/forum/article URL.
 *
 * Local/batch use only (Node/bun). Worker compatibility is out of scope (#139).
 *
 * Public API: `fetchFullText(url, sourceType)` returns a normalized `FetchResult`.
 *
 * Status semantics:
 *   ok        — body extracted, length >= MIN_TEXT_LENGTH
 *   blocked   — login page / captcha / adult-auth / private / 429
 *   not_found — 404 or removed post
 *   too_short — extracted but length < MIN_TEXT_LENGTH
 *   timeout   — request exceeded FETCH_TIMEOUT_MS
 *   error     — DNS / 5xx / parse failure / other
 */

import * as cheerio from 'cheerio'

export type SourceType = 'naver_blog' | 'naver_cafe' | 'ddg_search'

export type FetchStatus = 'ok' | 'blocked' | 'not_found' | 'too_short' | 'timeout' | 'error'

export interface FetchResult {
  status: FetchStatus
  text: string
  contentLength: number
  finalUrl: string
  reason?: string
}

export const MIN_TEXT_LENGTH = 200
export const FETCH_TIMEOUT_MS = 10_000
export const MAX_REDIRECTS = 5

// Test seam: pilot/tests can override the underlying fetcher.
export type FetchImpl = (url: string, init?: FetchInit) => Promise<FetchResponse>

export interface FetchInit {
  headers?: Record<string, string>
  redirect?: 'follow' | 'manual'
  signal?: AbortSignal
}

export interface FetchResponse {
  status: number
  url: string
  text(): Promise<string>
  headers: { get(name: string): string | null }
}

const DEFAULT_HEADERS: Record<string, string> = {
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'ko-KR,ko;q=0.9,en;q=0.8',
}

// ── internal utilities ─────────────────────────────────────────────────────

interface FetchedHtml {
  status: number
  finalUrl: string
  html: string
}

export async function fetchWithTimeout(
  url: string,
  init: FetchInit = {},
  fetchImpl: FetchImpl = globalThis.fetch as unknown as FetchImpl,
): Promise<FetchedHtml> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetchImpl(url, {
      headers: { ...DEFAULT_HEADERS, ...(init.headers ?? {}) },
      redirect: init.redirect ?? 'follow',
      signal: controller.signal,
    })
    const html = await res.text()
    return { status: res.status, finalUrl: res.url || url, html }
  } finally {
    clearTimeout(timer)
  }
}

export function normalizeFinalUrl(finalUrl: string, requestedUrl: string): string {
  return finalUrl && finalUrl.length > 0 ? finalUrl : requestedUrl
}

const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /captcha/i, reason: 'captcha' },
  { pattern: /로그인이?\s*필요/i, reason: 'login_required' },
  { pattern: /로그인\s*후\s*이용/i, reason: 'login_required' },
  { pattern: /성인\s*인증/i, reason: 'adult_auth' },
  { pattern: /19세\s*이상/i, reason: 'adult_auth' },
  { pattern: /비공개\s*(?:글|게시글|포스트)/i, reason: 'private_post' },
  { pattern: /가입\s*후\s*이용/i, reason: 'membership_required' },
  { pattern: /접근\s*권한/i, reason: 'access_denied' },
]

const NOT_FOUND_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /삭제\s*된\s*(?:글|게시글|포스트)/i, reason: 'deleted' },
  { pattern: /존재하지\s*않는\s*(?:글|페이지)/i, reason: 'not_found' },
  { pattern: /페이지를?\s*찾을\s*수\s*없습니다/i, reason: 'page_not_found' },
]

export function detectBlocked(
  html: string,
  httpStatus: number,
): { blocked: boolean; reason?: string } {
  if (httpStatus === 429) return { blocked: true, reason: 'rate_limited' }
  if (httpStatus === 401 || httpStatus === 403) return { blocked: true, reason: 'unauthorized' }
  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    if (pattern.test(html)) return { blocked: true, reason }
  }
  return { blocked: false }
}

export function detectNotFound(
  html: string,
  httpStatus: number,
): { notFound: boolean; reason?: string } {
  if (httpStatus === 404 || httpStatus === 410) return { notFound: true, reason: 'http_404' }
  for (const { pattern, reason } of NOT_FOUND_PATTERNS) {
    if (pattern.test(html)) return { notFound: true, reason }
  }
  return { notFound: false }
}

const AD_LINE_PATTERNS: RegExp[] = [
  /쿠팡\s*파트너스/,
  /이\s*포스팅은\s*쿠팡\s*파트너스/,
  /일정액의\s*수수료/,
]

export function cleanText(raw: string): string {
  // collapse whitespace, drop ad lines
  const lines = raw
    .replace(/ /g, ' ')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !AD_LINE_PATTERNS.some((p) => p.test(line)))
  const joined = lines.join('\n')
  return joined.replace(/[ \t]{2,}/g, ' ').trim()
}

export function statusFromTextLength(len: number): 'ok' | 'too_short' {
  return len >= MIN_TEXT_LENGTH ? 'ok' : 'too_short'
}

// ── error helpers ──────────────────────────────────────────────────────────

export function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.message.includes('aborted'))
}

// ── per-source extractors ──────────────────────────────────────────────────

const NAVER_BLOG_SELECTORS = ['.se-main-container', '.post-view', '#postViewArea']
const NAVER_CAFE_SELECTORS = [
  '.se-main-container',
  '.ContentRenderer',
  '.NHN_Writeform_Main',
  '#tbody',
]

export interface ExtractContext {
  fetchImpl?: FetchImpl
}

function pickSelector($: cheerio.CheerioAPI, selectors: string[]): string {
  for (const sel of selectors) {
    const node = $(sel).first()
    if (node.length > 0) {
      const text = node.text().trim()
      if (text.length > 0) return text
    }
  }
  return ''
}

export async function extractNaverBlog(
  url: string,
  ctx: ExtractContext = {},
): Promise<FetchResult> {
  const fetchImpl = ctx.fetchImpl ?? (globalThis.fetch as unknown as FetchImpl)
  let response: FetchedHtml
  try {
    response = await fetchWithTimeout(url, {}, fetchImpl)
  } catch (err) {
    if (isAbortError(err)) {
      return { status: 'timeout', text: '', contentLength: 0, finalUrl: url }
    }
    return {
      status: 'error',
      text: '',
      contentLength: 0,
      finalUrl: url,
      reason: asError(err).message,
    }
  }

  const blocked = detectBlocked(response.html, response.status)
  if (blocked.blocked) {
    return {
      status: 'blocked',
      text: '',
      contentLength: 0,
      finalUrl: response.finalUrl,
      reason: blocked.reason,
    }
  }
  const notFound = detectNotFound(response.html, response.status)
  if (notFound.notFound) {
    return {
      status: 'not_found',
      text: '',
      contentLength: 0,
      finalUrl: response.finalUrl,
      reason: notFound.reason,
    }
  }

  const $outer = cheerio.load(response.html)
  const iframeSrc = $outer('#mainFrame').attr('src')

  let inner: FetchedHtml = response
  if (iframeSrc && iframeSrc.length > 0) {
    const iframeUrl = iframeSrc.startsWith('http')
      ? iframeSrc
      : new URL(iframeSrc, response.finalUrl).toString()
    try {
      inner = await fetchWithTimeout(iframeUrl, {}, fetchImpl)
    } catch (err) {
      if (isAbortError(err)) {
        return { status: 'timeout', text: '', contentLength: 0, finalUrl: response.finalUrl }
      }
      return {
        status: 'error',
        text: '',
        contentLength: 0,
        finalUrl: response.finalUrl,
        reason: asError(err).message,
      }
    }
  }

  const $body = cheerio.load(inner.html)
  const raw = pickSelector($body, NAVER_BLOG_SELECTORS)
  const text = cleanText(raw)
  return {
    status: statusFromTextLength(text.length),
    text,
    contentLength: text.length,
    finalUrl: inner.finalUrl ?? response.finalUrl,
  }
}

function toMobileCafeUrl(url: string): string {
  try {
    const u = new URL(url)
    if (u.hostname === 'cafe.naver.com') {
      u.hostname = 'm.cafe.naver.com'
      return u.toString()
    }
    return url
  } catch {
    return url
  }
}

export async function extractNaverCafe(
  url: string,
  ctx: ExtractContext = {},
): Promise<FetchResult> {
  const fetchImpl = ctx.fetchImpl ?? (globalThis.fetch as unknown as FetchImpl)
  const mobileUrl = toMobileCafeUrl(url)

  let response: FetchedHtml
  try {
    response = await fetchWithTimeout(mobileUrl, {}, fetchImpl)
  } catch (err) {
    if (isAbortError(err)) {
      return { status: 'timeout', text: '', contentLength: 0, finalUrl: url }
    }
    return {
      status: 'error',
      text: '',
      contentLength: 0,
      finalUrl: url,
      reason: asError(err).message,
    }
  }

  const blocked = detectBlocked(response.html, response.status)
  if (blocked.blocked) {
    return {
      status: 'blocked',
      text: '',
      contentLength: 0,
      finalUrl: response.finalUrl,
      reason: blocked.reason,
    }
  }
  const notFound = detectNotFound(response.html, response.status)
  if (notFound.notFound) {
    return {
      status: 'not_found',
      text: '',
      contentLength: 0,
      finalUrl: response.finalUrl,
      reason: notFound.reason,
    }
  }

  const $ = cheerio.load(response.html)
  const raw = pickSelector($, NAVER_CAFE_SELECTORS)
  const text = cleanText(raw)

  if (text.length < MIN_TEXT_LENGTH && isCafeSpaShell(response.html)) {
    return {
      status: 'blocked',
      text: '',
      contentLength: 0,
      finalUrl: response.finalUrl,
      reason: 'spa_shell',
    }
  }

  return {
    status: statusFromTextLength(text.length),
    text,
    contentLength: text.length,
    finalUrl: response.finalUrl,
  }
}

// Cafe migrated to a JS-rendered SPA. The shell HTML carries no body content
// reachable by static selectors, so we surface this as a distinct blocked reason
// instead of conflating with too_short (which implies the extractor matched
// something but it was tiny).
//
// Detection strategy: the SPA shell identifies itself with the generic
// "<title>네이버 카페</title>" (a real article would include the post title in
// the HTML <title>) plus the static asset host (`ca-fe.pstatic.net/web-mobile`)
// or the about:blank iframe pattern, with no body-selector match.
function isCafeSpaShell(html: string): boolean {
  const isCafeHost = /cafe\.naver\.com|네이버\s*카페/i.test(html)
  if (!isCafeHost) return false
  const genericTitle = /<title>\s*네이버\s*카페\s*<\/title>/i.test(html)
  const spaAssets = /ca-fe\.pstatic\.net\/web-mobile/i.test(html)
  if (genericTitle && spaAssets) return true
  if (/about:blank/.test(html)) return true
  if (/<div\s+id=["']__next["']/.test(html)) return true
  if (/<div\s+id=["']root["']\s*>\s*<\/div>/.test(html)) return true
  return false
}

const DDG_FALLBACK_SELECTORS = ['article', 'main', 'body']

interface ReadabilityArticle {
  textContent?: string | null
}

export async function extractGenericArticle(
  url: string,
  ctx: ExtractContext = {},
): Promise<FetchResult> {
  const fetchImpl = ctx.fetchImpl ?? (globalThis.fetch as unknown as FetchImpl)

  let response: FetchedHtml
  try {
    response = await fetchWithTimeout(url, {}, fetchImpl)
  } catch (err) {
    if (isAbortError(err)) {
      return { status: 'timeout', text: '', contentLength: 0, finalUrl: url }
    }
    return {
      status: 'error',
      text: '',
      contentLength: 0,
      finalUrl: url,
      reason: asError(err).message,
    }
  }

  const blocked = detectBlocked(response.html, response.status)
  if (blocked.blocked) {
    return {
      status: 'blocked',
      text: '',
      contentLength: 0,
      finalUrl: response.finalUrl,
      reason: blocked.reason,
    }
  }
  const notFound = detectNotFound(response.html, response.status)
  if (notFound.notFound) {
    return {
      status: 'not_found',
      text: '',
      contentLength: 0,
      finalUrl: response.finalUrl,
      reason: notFound.reason,
    }
  }

  let raw = ''
  // Try Mozilla Readability via dynamic import (avoid eager jsdom load on Worker-like runtimes).
  try {
    const article = await runReadability(response.html, response.finalUrl)
    if (article?.textContent && article.textContent.trim().length > 0) {
      raw = article.textContent
    }
  } catch {
    // fall through to cheerio fallback
  }

  if (raw.length === 0) {
    const $ = cheerio.load(response.html)
    raw = pickSelector($, DDG_FALLBACK_SELECTORS)
  }

  const text = cleanText(raw)
  return {
    status: statusFromTextLength(text.length),
    text,
    contentLength: text.length,
    finalUrl: response.finalUrl,
  }
}

async function runReadability(html: string, url: string): Promise<ReadabilityArticle | null> {
  const [{ Readability }, { JSDOM }] = await Promise.all([
    import('@mozilla/readability'),
    import('jsdom'),
  ])
  const dom = new JSDOM(html, { url })
  const reader = new Readability(dom.window.document)
  return reader.parse() as ReadabilityArticle | null
}

// ── public entrypoint ──────────────────────────────────────────────────────

export async function fetchFullText(
  url: string,
  sourceType: SourceType,
  ctx: ExtractContext = {},
): Promise<FetchResult> {
  switch (sourceType) {
    case 'naver_blog':
      return extractNaverBlog(url, ctx)
    case 'naver_cafe':
      return extractNaverCafe(url, ctx)
    case 'ddg_search':
      return extractGenericArticle(url, ctx)
  }
}
