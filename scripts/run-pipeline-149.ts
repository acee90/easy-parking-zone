/**
 * #149 파이프라인 스크립트 — rule filter + match (API 키 불필요)
 *
 * AI 판정은 Claude subagent가 처리. 스크립트는 SQL 생성만 담당.
 *
 * Usage:
 *   bun run scripts/run-pipeline-149.ts --remote --stage fulltext-fetch [--limit N] [--concurrency N] [--sleep N]
 *   bun run scripts/run-pipeline-149.ts --remote --stage filter  [--limit N]
 *   bun run scripts/run-pipeline-149.ts --remote --stage match-dump  [--limit N]
 *   bun run scripts/run-pipeline-149.ts --remote --stage match-apply --ai-results FILE
 *   bun run scripts/run-pipeline-149.ts --remote --apply local|remote|both  (이미 emit된 파일 적용)
 *
 * 스테이지:
 *   fulltext-fetch — pending 레코드 URL fetch → full_text 업데이트 SQL emit
 *   filter         — rule filter UPDATE SQL emit
 *   match-dump     — 고신뢰 match INSERT SQL + medium 후보 JSON emit
 *   match-apply    — subagent AI 결과 읽어서 match INSERT SQL emit
 *
 * 출력: /tmp/pipeline-149-{timestamp}/
 *   fulltext-chunk-NN.sql      — full_text UPDATE (ok/blocked/too_short/error 등)
 *   filter-chunk-NN.sql        — rule filter UPDATE
 *   match-direct-chunk-NN.sql  — high-high match INSERT + matched_at UPDATE
 *   medium-candidates.json     — AI 평가용 medium 후보 목록
 *   match-ai-chunk-NN.sql      — AI 통과 INSERT + matched_at UPDATE
 */

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { classifyByRule, type RuleFilterInput } from '../src/server/crawlers/lib/rule-filter'
import {
  extractNameKeywords,
  getMatchConfidence,
  stripHtml,
} from '../src/server/crawlers/lib/scoring'
import { d1Query, isRemote, localDbPath } from './lib/d1'
import { esc, sqlVal } from './lib/sql-flush'

// ── 인자 파싱 ─────────────────────────────────────────────────────

const args = process.argv.slice(2)

function argVal(flag: string): string | null {
  const i = args.indexOf(flag)
  return i >= 0 ? (args[i + 1] ?? null) : null
}

const STAGE = argVal('--stage') ?? ''
const LIMIT = parseInt(argVal('--limit') ?? '300', 10)
const CONCURRENCY = parseInt(argVal('--concurrency') ?? '3', 10)
const SLEEP_MS = parseInt(argVal('--sleep') ?? '500', 10)
const AI_RESULTS_FILE = argVal('--ai-results')
const APPLY = argVal('--apply') // 'local' | 'remote' | 'both'

if (!isRemote && !localDbPath) {
  console.error('⚠️  --remote 또는 --db PATH 플래그가 필요합니다.')
  process.exit(1)
}

if (!['fulltext-fetch', 'filter', 'match-dump', 'match-apply', ''].includes(STAGE)) {
  console.error(
    `⚠️  알 수 없는 stage: "${STAGE}". fulltext-fetch | filter | match-dump | match-apply 중 선택.`,
  )
  process.exit(1)
}

if (STAGE === 'match-apply' && !AI_RESULTS_FILE) {
  console.error('⚠️  match-apply는 --ai-results FILE 필요.')
  process.exit(1)
}

// ── 상수 ──────────────────────────────────────────────────────────

const FTS_LIMIT = 5
const SQL_CHUNK_SIZE = 300
const DB_NAME = 'parking-db'
const MAX_FULLTEXT_BYTES = 30_000
const CRAWL4AI_URL = argVal('--crawl4ai-url') ?? 'https://crawl.arttoken.biz'
const C4AI_TIMEOUT_MS = 30_000
const MIN_TEXT_LENGTH = 200

const tmpDir = argVal('--out') ?? `/tmp/pipeline-149-${Date.now()}`
mkdirSync(tmpDir, { recursive: true })

let chunkIdx = 0
const emittedFiles: string[] = []

// ── SQL 유틸 ──────────────────────────────────────────────────────

function emitSqlChunk(prefix: string, statements: string[]): void {
  if (statements.length === 0) return
  const name = `${prefix}-chunk-${String(++chunkIdx).padStart(2, '0')}.sql`
  const path = `${tmpDir}/${name}`
  const sql = statements.join('\n')
  writeFileSync(path, sql, 'utf-8')
  emittedFiles.push(path)
  console.log(`  → ${name} (${statements.length} rows)`)
}

// ── 타입 ──────────────────────────────────────────────────────────

interface RawRow {
  id: number
  source: string
  source_id: string
  source_url: string
  title: string
  content: string
  author: string | null
  published_at: string | null
  sentiment_score: number | null
  ai_difficulty_keywords: string | null
  full_text: string | null
  full_text_status: string | null
  full_text_fetched_at: string | null
  filter_tier: string | null
}

interface LotRow {
  lot_id: string
  name: string
  address: string
}

export interface MediumCandidate {
  raw_id: number
  lot_id: string
  lot_name: string
  lot_address: string
  score: number
  title: string
  full_text: string
}

export interface AiResult {
  raw_id: number
  lot_id: string
  filter_passed: boolean
  removed_by: string | null
  sentiment_score: number
  ai_difficulty_keywords: string[]
}

// ── full_text 기반 lot_name 존재 여부 체크 ─────────────────────────

function lotNameInFullText(lotName: string, fullText: string, title: string = ''): boolean {
  const keywords = extractNameKeywords(lotName)
  const text = (title + ' ' + fullText).toLowerCase()
  // 전체 이름 키워드(keywords[0])가 3자 이상이면 그것만으로 통과 판정
  const fullNameKw = keywords[0]
  if (fullNameKw && fullNameKw.length >= 3 && text.includes(fullNameKw)) return true
  // 그 외: 길이 3 이상 키워드 중 2개 이상 포함 여부 확인
  const longKws = keywords.filter((kw) => kw.length >= 3)
  const matchCount = longKws.filter((kw) => text.includes(kw)).length
  return matchCount >= Math.min(2, longKws.length)
}

// ── 키워드 + FTS ───────────────────────────────────────────────────

const STOP_WORDS = new Set([
  '주차장',
  '주차',
  '후기',
  '정보',
  '공유',
  '추천',
  '이용',
  '이용후기',
  '요금',
  '무료',
  '저렴',
  '가격',
  '시간',
  '위치',
  '근처',
  '주변',
  '최신',
  '리스트',
  '포함',
  '안내',
  '방법',
  '꿀팁',
  '총정리',
  '비교',
  '네이버',
  '블로그',
  '카페',
  '유튜브',
  '플레이스',
  '리뷰',
  // 장소 유형 제네릭 명사 — 단독 키워드로는 너무 범용적
  '축구장',
  '야구장',
  '수영장',
  '운동장',
  '경기장',
  '공연장',
  '박물관',
  '미술관',
  '도서관',
  '터미널',
  '입장',
  '관람',
  '가볼만한곳',
  // 주차장 유형 수식어 — lot name에 포함돼도 너무 범용적 (공영주차장 등)
  '공영',
  '민영',
  '노상',
  '노외',
  '부설',
  '임시',
  '기계식',
])

function extractSearchKeywords(title: string, content: string): string[] {
  // Primary: words before '주차장' in title
  if (title.includes('주차장')) {
    const parkingIdx = title.indexOf('주차장')
    const beforeParking = title.slice(0, parkingIdx).trim()
    const words = beforeParking
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 2 && !STOP_WORDS.has(w) && !/^\d+$/.test(w))
    const unique = [...new Set(words)]
    const candidates = unique.slice(-3)
    if (candidates.length > 0 && candidates.some((w) => w.length >= 2)) return candidates
  }

  // Fallback 1: strip parking keywords from title, extract remaining
  const titleCleaned = title
    .replace(/주차장|주차/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w) && !/^\d+$/.test(w))
  const titleUnique = [...new Set(titleCleaned)]
  if (titleUnique.length > 0) return titleUnique.slice(0, 4)

  // Fallback 2: extract from content snippet (covers "XX 방문기" titles with parking in body)
  const contentCleaned = content
    .slice(0, 300)
    .replace(/주차장|주차/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w) && !/^\d+$/.test(w))
  const contentUnique = [...new Set(contentCleaned)]
  if (contentUnique.length === 0) return []
  return contentUnique.slice(0, 4)
}

// 추출한 키워드가 lot name에 포함돼야 지리적으로 연관있는 후보
// 키워드 모두가 lot name에 포함돼야 통과 (some → every) — 브랜드 오매칭 방지
function isCandidateLocationCompatible(keywords: string[], lot: LotRow): boolean {
  if (keywords.length === 0) return false
  const lotName = lot.name.toLowerCase()
  return keywords.every((kw) => kw.length >= 2 && lotName.includes(kw.toLowerCase()))
}

function searchCandidateLots(keywords: string[]): LotRow[] {
  if (keywords.length === 0) return []
  const seen = new Set<string>()
  const results: LotRow[] = []

  // 정확 phrase 매칭만 사용 — wildcard(kw*) 제거로 "갤러리" → "갤러리아" 오매칭 방지
  const ftsQuery = keywords.map((kw) => `"${kw}"`).join(' OR ')
  try {
    const rows = d1Query<LotRow>(
      `SELECT lot_id, name, address FROM parking_lots_fts WHERE parking_lots_fts MATCH '${esc(ftsQuery)}' LIMIT ${FTS_LIMIT}`,
    )
    for (const r of rows) {
      if (!seen.has(r.lot_id)) {
        seen.add(r.lot_id)
        results.push(r)
      }
    }
  } catch {
    /* FTS 오류 시 빈 결과 반환 */
  }

  return results
}

// ── INSERT SQL 생성 ───────────────────────────────────────────────

const MISSED_LOT_ID = 'MISSED'

function buildMissedLotInsertSql(raw: RawRow, detectedName: string): string {
  const cols = [
    'parking_lot_id',
    'missed_lot_name',
    'source',
    'source_id',
    'title',
    'content',
    'source_url',
    'author',
    'published_at',
    'relevance_score',
    'raw_source_id',
    'sentiment_score',
    'ai_difficulty_keywords',
    'ai_summary',
    'full_text',
    'full_text_length',
    'full_text_status',
    'full_text_fetched_at',
  ]
  const vals = [
    MISSED_LOT_ID,
    detectedName,
    raw.source,
    `${raw.source_id}:${MISSED_LOT_ID}`,
    stripHtml(raw.title),
    stripHtml(raw.content),
    raw.source_url,
    raw.author,
    raw.published_at,
    0,
    raw.id,
    raw.sentiment_score,
    raw.ai_difficulty_keywords,
    null,
    raw.full_text,
    raw.full_text ? raw.full_text.length : 0,
    raw.full_text_status ?? 'pending',
    raw.full_text_fetched_at,
  ]
    .map(sqlVal)
    .join(', ')

  return `INSERT OR IGNORE INTO web_sources (${cols.join(', ')}) VALUES (${vals});`
}

function buildInsertSql(
  raw: RawRow,
  lot: LotRow,
  score: number,
  aiResult: AiResult | null,
): string {
  const sentimentScore = aiResult?.sentiment_score ?? raw.sentiment_score
  const difficultyKw = aiResult?.ai_difficulty_keywords
    ? JSON.stringify(aiResult.ai_difficulty_keywords)
    : raw.ai_difficulty_keywords

  const cols = [
    'parking_lot_id',
    'source',
    'source_id',
    'title',
    'content',
    'source_url',
    'author',
    'published_at',
    'relevance_score',
    'raw_source_id',
    'sentiment_score',
    'ai_difficulty_keywords',
    'ai_summary',
    'full_text',
    'full_text_length',
    'full_text_status',
    'full_text_fetched_at',
  ]
  const vals = [
    lot.lot_id,
    raw.source,
    `${raw.source_id}:${lot.lot_id}`,
    stripHtml(raw.title),
    stripHtml(raw.content),
    raw.source_url,
    raw.author,
    raw.published_at,
    score,
    raw.id,
    sentimentScore,
    difficultyKw,
    null, // ai_summary는 ai-summary-generator에서 별도 생성
    raw.full_text,
    raw.full_text ? raw.full_text.length : 0,
    raw.full_text_status ?? 'pending',
    raw.full_text_fetched_at,
  ]
    .map(sqlVal)
    .join(', ')

  return `INSERT OR IGNORE INTO web_sources (${cols.join(', ')}) VALUES (${vals});`
}

// ── Stage 0: Full Text Fetch (via crawl4ai) ───────────────────────

type C4aiStatus = 'ok' | 'blocked' | 'not_found' | 'too_short' | 'timeout' | 'error'

function toMobileUrl(url: string, source: string): string {
  try {
    const u = new URL(url)
    if (source === 'naver_blog' && u.hostname === 'blog.naver.com') {
      u.hostname = 'm.blog.naver.com'
      return u.toString()
    }
    if (source === 'naver_cafe' && u.hostname === 'cafe.naver.com') {
      u.hostname = 'm.cafe.naver.com'
      return u.toString()
    }
  } catch {
    /* noop */
  }
  return url
}

async function fetchViaC4ai(url: string): Promise<{ status: C4aiStatus; text: string }> {
  try {
    const res = await fetch(`${CRAWL4AI_URL}/crawl`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: [url], word_count_threshold: 10 }),
      signal: AbortSignal.timeout(C4AI_TIMEOUT_MS),
    })
    if (!res.ok) return { text: '', status: 'error' }
    const data = (await res.json()) as {
      results: Array<{ markdown: { raw_markdown: string }; status_code: number }>
    }
    const result = data.results?.[0]
    if (!result) return { text: '', status: 'error' }
    if (result.status_code === 404) return { text: '', status: 'not_found' }
    if (result.status_code === 401 || result.status_code === 403)
      return { text: '', status: 'blocked' }
    const text = result.markdown?.raw_markdown?.trim() ?? ''
    if (text.length < MIN_TEXT_LENGTH) return { text, status: 'too_short' }
    if (text.length > MAX_FULLTEXT_BYTES)
      return { text: text.slice(0, MAX_FULLTEXT_BYTES), status: 'ok' }
    return { text, status: 'ok' }
  } catch (e) {
    if (e instanceof Error && e.name === 'TimeoutError') return { text: '', status: 'timeout' }
    return { text: '', status: 'error' }
  }
}

async function runFullTextFetchStage() {
  console.log('\n🌐 Stage: fulltext-fetch (crawl4ai)')
  console.log(`  url=${CRAWL4AI_URL}  concurrency=${CONCURRENCY}  sleep=${SLEEP_MS}ms`)

  const rows = d1Query<{ id: number; source: string; source_url: string }>(
    `SELECT id, source, source_url FROM web_sources_raw
     WHERE full_text_status = 'pending' AND source_url LIKE 'http%'
     ORDER BY id LIMIT ${LIMIT}`,
  )
  console.log(`  대상: ${rows.length}건`)
  if (rows.length === 0) {
    return { processed: 0, ok: 0, blocked: 0, not_found: 0, too_short: 0, timeout: 0, error: 0 }
  }

  const counters = { ok: 0, blocked: 0, not_found: 0, too_short: 0, timeout: 0, error: 0 }
  let total = 0
  const buf: string[] = []

  const flushBuf = () => {
    if (buf.length === 0) return
    emitSqlChunk('fulltext', buf.splice(0))
  }

  const buildFetchUpdate = (id: number, status: C4aiStatus, text: string): string => {
    const fullTextVal = status === 'ok' ? sqlVal(text) : 'NULL'
    return `UPDATE web_sources_raw SET full_text = ${fullTextVal}, full_text_status = '${status}', full_text_fetched_at = datetime('now') WHERE id = ${id};`
  }

  const queue = [...rows]
  let active = 0

  await new Promise<void>((resolveAll) => {
    const launch = (): void => {
      while (active < CONCURRENCY && queue.length > 0) {
        const row = queue.shift()!
        active++
        const mobileUrl = toMobileUrl(row.source_url, row.source)
        fetchViaC4ai(mobileUrl)
          .then(({ status, text }) => {
            total++
            counters[status]++
            buf.push(buildFetchUpdate(row.id, status, text))
            process.stdout.write(
              `\r  진행: ${total}/${rows.length}  ok:${counters.ok}  blocked:${counters.blocked}  too_short:${counters.too_short}  error:${counters.error}  `,
            )
            if (buf.length >= SQL_CHUNK_SIZE) flushBuf()
          })
          .catch(() => {
            total++
            counters.error++
            buf.push(buildFetchUpdate(row.id, 'error', ''))
          })
          .finally(async () => {
            if (SLEEP_MS > 0) await new Promise((r) => setTimeout(r, SLEEP_MS))
            active--
            launch()
            if (active === 0 && queue.length === 0) resolveAll()
          })
      }
    }
    launch()
  })

  console.log()
  flushBuf()

  return { processed: rows.length, ...counters }
}

// ── Stage 1: Rule Filter ──────────────────────────────────────────

async function runFilterStage() {
  console.log('\n📋 Stage: filter')
  const rows = d1Query<{
    id: number
    title: string
    full_text: string | null
    full_text_status: string | null
  }>(
    `SELECT id, title, full_text, full_text_status
     FROM web_sources_raw
     WHERE ai_filtered_at IS NULL AND full_text_status = 'ok'
     ORDER BY id LIMIT ${LIMIT}`,
  )
  console.log(`  대상: ${rows.length}건`)
  if (rows.length === 0) return { processed: 0, high: 0, medium: 0, low: 0 }

  let high = 0,
    medium = 0,
    low = 0
  const buf: string[] = []

  for (const row of rows) {
    const tier = classifyByRule({
      fullText: row.full_text,
      fullTextStatus: row.full_text_status,
      title: row.title,
    } as RuleFilterInput)
    if (tier === 'low') {
      buf.push(
        `UPDATE web_sources_raw SET filter_passed = 0, filter_removed_by = 'rule_low', filter_tier = 'low', ai_filtered_at = datetime('now') WHERE id = ${row.id};`,
      )
      low++
    } else {
      buf.push(
        `UPDATE web_sources_raw SET filter_passed = 1, filter_tier = '${tier}', ai_filtered_at = datetime('now') WHERE id = ${row.id};`,
      )
      if (tier === 'high') high++
      else medium++
    }
    if (buf.length >= SQL_CHUNK_SIZE) emitSqlChunk('filter', buf.splice(0))
  }
  if (buf.length > 0) emitSqlChunk('filter', buf)

  return { processed: rows.length, high, medium, low }
}

// ── Stage 2a: Match Dump ──────────────────────────────────────────

async function runMatchDumpStage() {
  console.log('\n🔍 Stage: match-dump')
  const rows = d1Query<RawRow>(
    `SELECT id, source, source_id, source_url, title, content, author, published_at,
            sentiment_score, ai_difficulty_keywords,
            full_text, full_text_status, full_text_fetched_at, filter_tier
     FROM web_sources_raw
     WHERE filter_passed = 1 AND matched_at IS NULL
     ORDER BY id LIMIT ${LIMIT}`,
  )
  console.log(`  대상: ${rows.length}건`)
  if (rows.length === 0)
    return { processed: 0, directLinks: 0, wrongLotSkipped: 0, mediumCandidates: 0 }

  let directLinks = 0
  let wrongLotSkipped = 0
  let keywordsEmptySkipped = 0
  let confidenceNoneSkipped = 0
  let preFilterSkipped = 0
  let mediumCapSkipped = 0
  let missedLotCount = 0
  const directInserts: string[] = []
  const directUpdates: string[] = []
  const missedInserts: string[] = []
  const missedUpdates: string[] = []
  const mediumCandidates: MediumCandidate[] = []
  const mediumCountPerRaw = new Map<number, number>() // raw_id → medium candidate count
  const immediateMatchedIds = new Set<number>()
  const MEDIUM_CAP_PER_RAW = 2 // 같은 글에서 최대 2개 lot만 AI에 위임

  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i]
    const title = stripHtml(raw.title)
    const content = stripHtml(raw.content)
    const fullText = raw.full_text ?? content
    const isRuleHigh = raw.filter_tier === 'high'

    const keywords = extractSearchKeywords(title, content)
    if (keywords.length === 0) keywordsEmptySkipped++
    const candidates = searchCandidateLots(keywords)

    const highMatches: Array<{ lot: LotRow; score: number }> = []
    const mediumMatches: Array<{ lot: LotRow; score: number }> = []
    // confidence=none: rule tier 무관하게 항상 AI (direct insert 불가)
    const aiOnlyCandidates: Array<{ lot: LotRow; score: number }> = []

    for (const lot of candidates) {
      // 키워드가 lot name에 없으면 지역 불일치 → skip (e.g. 관악구 글 → 남해 축구장)
      if (!isCandidateLocationCompatible(keywords, lot)) {
        wrongLotSkipped++
        continue
      }

      // full_text가 충분하면 lot name이 본문에 등장해야 연관 후보 (wrong_lot 사전 제거)
      if (fullText.length > 200 && !lotNameInFullText(lot.name, fullText, title)) {
        preFilterSkipped++
        continue
      }

      const { score, confidence } = getMatchConfidence(title, content, lot.name, lot.address)
      if (confidence === 'none') {
        // none이어도 AI에게 위임 — rule=high라도 direct insert 불가
        confidenceNoneSkipped++
        aiOnlyCandidates.push({ lot, score })
        continue
      }

      if (confidence === 'high') highMatches.push({ lot, score })
      else mediumMatches.push({ lot, score })
    }

    // match=high: rule=high → direct, rule!=high → AI
    for (const { lot, score } of highMatches) {
      if (isRuleHigh) {
        directInserts.push(buildInsertSql(raw, lot, score, null))
        directLinks++
      } else {
        mediumMatches.push({ lot, score })
      }
    }

    // match=medium: rule=high → direct (AI 불필요), rule!=high → AI
    for (const { lot, score } of mediumMatches) {
      if (isRuleHigh) {
        directInserts.push(buildInsertSql(raw, lot, score, null))
        directLinks++
      } else {
        const cnt = mediumCountPerRaw.get(raw.id) ?? 0
        if (cnt >= MEDIUM_CAP_PER_RAW) {
          mediumCapSkipped++
          continue
        }
        mediumCountPerRaw.set(raw.id, cnt + 1)
        mediumCandidates.push({
          raw_id: raw.id,
          lot_id: lot.lot_id,
          lot_name: lot.name,
          lot_address: lot.address,
          score,
          title,
          full_text: fullText.slice(0, 6000),
        })
      }
    }

    // aiOnlyCandidates: confidence=none → 항상 AI (rule=high라도 direct 불가)
    for (const { lot, score } of aiOnlyCandidates) {
      const cnt = mediumCountPerRaw.get(raw.id) ?? 0
      if (cnt >= MEDIUM_CAP_PER_RAW) {
        mediumCapSkipped++
        continue
      }
      mediumCountPerRaw.set(raw.id, cnt + 1)
      mediumCandidates.push({
        raw_id: raw.id,
        lot_id: lot.lot_id,
        lot_name: lot.name,
        lot_address: lot.address,
        score,
        title,
        full_text: fullText.slice(0, 6000),
      })
    }

    const hasAnyMatch =
      highMatches.length > 0 || mediumMatches.length > 0 || aiOnlyCandidates.length > 0
    const attempted = candidates.length > 0 || keywords.length > 0

    if (!hasAnyMatch && attempted) {
      if (keywords.length > 0 && candidates.length === 0 && raw.full_text_status === 'ok') {
        // FTS 결과 0건 — lot이 DB에 없는 경우: web_sources에 MISSED로 보존
        const detectedName = keywords.join(' ')
        missedInserts.push(buildMissedLotInsertSql(raw, detectedName))
        missedUpdates.push(
          `UPDATE web_sources_raw SET matched_at = datetime('now'), match_fail_reason = 'lot_not_in_db' WHERE id = ${raw.id};`,
        )
        missedLotCount++
        immediateMatchedIds.add(raw.id)
      } else {
        directUpdates.push(
          `UPDATE web_sources_raw SET matched_at = datetime('now') WHERE id = ${raw.id};`,
        )
        immediateMatchedIds.add(raw.id)
      }
    }

    if ((i + 1) % 50 === 0 || i === rows.length - 1) {
      process.stdout.write(
        `\r  진행: ${i + 1}/${rows.length}  직접: ${directLinks}  medium: ${mediumCandidates.length}  missed: ${missedLotCount}  noKw: ${keywordsEmptySkipped}  locSkip: ${wrongLotSkipped}  preFilter: ${preFilterSkipped}  `,
      )
    }

    if (directInserts.length + directUpdates.length >= SQL_CHUNK_SIZE) {
      emitSqlChunk('match-direct', [...directInserts.splice(0), ...directUpdates.splice(0)])
    }
    if (missedInserts.length + missedUpdates.length >= SQL_CHUNK_SIZE) {
      emitSqlChunk('missed-lot', [...missedInserts.splice(0), ...missedUpdates.splice(0)])
    }
  }

  if (directInserts.length + directUpdates.length > 0) {
    emitSqlChunk('match-direct', [...directInserts, ...directUpdates])
  }
  if (missedInserts.length + missedUpdates.length > 0) {
    emitSqlChunk('missed-lot', [...missedInserts, ...missedUpdates])
  }
  console.log()

  const CHUNK_SIZE = 20
  const chunkCount = Math.ceil(mediumCandidates.length / CHUNK_SIZE)
  const candidatesFiles: string[] = []

  for (let i = 0; i < chunkCount; i++) {
    const chunk = mediumCandidates.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)
    const suffix = chunkCount > 1 ? `-${String(i + 1).padStart(2, '0')}` : ''
    const chunkFile = `${tmpDir}/medium-candidates${suffix}.json`
    writeFileSync(
      chunkFile,
      JSON.stringify({ candidates: chunk, generated_at: new Date().toISOString() }, null, 2),
      'utf-8',
    )
    candidatesFiles.push(chunkFile)
    console.log(`  → ${chunkFile.split('/').pop()} (${chunk.length}건)`)
  }

  const candidatesFile = candidatesFiles[0]

  return {
    processed: rows.length,
    directLinks,
    wrongLotSkipped,
    missedLotCount,
    mediumCandidates: mediumCandidates.length,
    candidatesFile,
    candidatesFiles,
  }
}

// ── Stage 2b: Match Apply (AI 결과 반영) ─────────────────────────

async function runMatchApplyStage() {
  console.log('\n✅ Stage: match-apply')

  if (!AI_RESULTS_FILE || !existsSync(AI_RESULTS_FILE)) {
    console.error(`⚠️  AI 결과 파일 없음: ${AI_RESULTS_FILE}`)
    process.exit(1)
  }

  // 같은 디렉토리에 있는 모든 ai-results*.json 병합
  const resultsDir = AI_RESULTS_FILE.replace(/\/[^/]+$/, '')
  const { readdirSync } = await import('node:fs')
  const allResultFiles = readdirSync(resultsDir)
    .filter((f) => f.startsWith('ai-results') && f.endsWith('.json'))
    .sort()
    .map((f) => `${resultsDir}/${f}`)

  const allResults: AiResult[] = []
  for (const file of allResultFiles) {
    const { results } = JSON.parse(readFileSync(file, 'utf-8')) as { results: AiResult[] }
    allResults.push(...results)
  }

  if (allResultFiles.length > 1) {
    console.log(`  AI 결과 파일 ${allResultFiles.length}개 병합: ${allResults.length}건`)
  } else {
    console.log(`  AI 결과: ${allResults.length}건`)
  }

  const results = allResults
  const passingIds = results.filter((r) => r.filter_passed).map((r) => r.raw_id)
  if (passingIds.length === 0) {
    console.log('  통과 항목 없음.')
    return { aiTotal: results.length, aiPassed: 0, removalBreakdown: {} }
  }

  // raw 데이터 재조회 (통과 항목만)
  const idList = [...new Set(passingIds)].join(', ')
  const rawRows = d1Query<RawRow>(
    `SELECT id, source, source_id, source_url, title, content, author, published_at,
            sentiment_score, ai_difficulty_keywords,
            full_text, full_text_status, full_text_fetched_at, filter_tier
     FROM web_sources_raw WHERE id IN (${idList})`,
  )
  const rawById = new Map(rawRows.map((r) => [r.id, r]))

  // medium-candidates*.json에서 원래 score 복원 (청크 파일 모두 스캔)
  const scoreMap = new Map<string, number>()
  const candidateFiles = readdirSync(resultsDir)
    .filter((f) => f.startsWith('medium-candidates') && f.endsWith('.json'))
    .map((f) => `${resultsDir}/${f}`)
  for (const cf of candidateFiles) {
    if (existsSync(cf)) {
      const { candidates }: { candidates: MediumCandidate[] } = JSON.parse(
        readFileSync(cf, 'utf-8'),
      )
      for (const c of candidates) scoreMap.set(`${c.raw_id}:${c.lot_id}`, c.score)
    }
  }

  const inserts: string[] = []
  const updates: string[] = []
  const allRawIds = new Set(results.map((r) => r.raw_id))
  const removalBreakdown: Record<string, number> = {}

  for (const result of results) {
    if (result.filter_passed) {
      const raw = rawById.get(result.raw_id)
      if (raw) {
        const score = scoreMap.get(`${result.raw_id}:${result.lot_id}`) ?? 0
        inserts.push(
          buildInsertSql(raw, { lot_id: result.lot_id, name: '', address: '' }, score, result),
        )
      }
    } else {
      const reason = result.removed_by ?? 'unknown'
      removalBreakdown[reason] = (removalBreakdown[reason] ?? 0) + 1
    }
  }

  // matched_at 업데이트 (모든 AI 평가 대상 raw_id)
  for (const rawId of allRawIds) {
    updates.push(`UPDATE web_sources_raw SET matched_at = datetime('now') WHERE id = ${rawId};`)
  }

  const all = [...inserts, ...updates]
  for (let i = 0; i < all.length; i += SQL_CHUNK_SIZE) {
    emitSqlChunk('match-ai', all.slice(i, i + SQL_CHUNK_SIZE))
  }

  return { aiTotal: results.length, aiPassed: inserts.length, removalBreakdown }
}

// ── Apply SQL Files ───────────────────────────────────────────────

function applySqlFiles(target: 'local' | 'remote', files: string[]): void {
  const flag = target === 'remote' ? '--remote' : '--local'
  console.log(`\n🚀 apply → ${target}`)
  for (const filePath of files) {
    process.stdout.write(`  ${filePath.split('/').pop()} ...`)
    execSync(`bunx wrangler d1 execute ${DB_NAME} ${flag} --file="${filePath}"`, { stdio: 'pipe' })
    console.log(' ✓')
  }
}

// ── Main ──────────────────────────────────────────────────────────

function pct(n: number, total: number) {
  return total > 0 ? `${((n / total) * 100).toFixed(1)}%` : '-'
}

async function main() {
  // --apply only (이미 emit된 파일 적용)
  if (!STAGE && APPLY) {
    const dir = argVal('--out') ?? ''
    if (!dir) {
      console.error('⚠️  --out DIR 필요')
      process.exit(1)
    }
    const files = require('node:fs')
      .readdirSync(dir)
      .filter((f: string) => f.endsWith('.sql'))
      .map((f: string) => `${dir}/${f}`)
    if (APPLY === 'local' || APPLY === 'remote' || APPLY === 'both') applySqlFiles('local', files)
    if (APPLY === 'remote' || APPLY === 'both') applySqlFiles('remote', files)
    return
  }

  console.log('\n🚀 #149 파이프라인')
  console.log(`   stage=${STAGE || '(none)'}  limit=${LIMIT}  apply=${APPLY ?? '없음'}`)
  console.log(`   출력: ${tmpDir}\n`)

  let fetchStats: Awaited<ReturnType<typeof runFullTextFetchStage>> | null = null
  let filterStats: Awaited<ReturnType<typeof runFilterStage>> | null = null
  let dumpStats: Awaited<ReturnType<typeof runMatchDumpStage>> | null = null
  let applyStats: Awaited<ReturnType<typeof runMatchApplyStage>> | null = null

  if (STAGE === 'fulltext-fetch') fetchStats = await runFullTextFetchStage()
  if (STAGE === 'filter') filterStats = await runFilterStage()
  if (STAGE === 'match-dump') dumpStats = await runMatchDumpStage()
  if (STAGE === 'match-apply') applyStats = await runMatchApplyStage()

  // 리포트
  const sep = '─'.repeat(52)
  console.log(`\n${sep}\n📊 Report`)
  console.log(sep)

  if (fetchStats?.processed) {
    const { processed: p, ok, blocked, not_found, too_short, timeout, error } = fetchStats
    console.log(`\n[Fulltext Fetch]  ${p}건`)
    console.log(`  ok        ${String(ok).padStart(5)}건  (${pct(ok, p)})`)
    console.log(`  blocked   ${String(blocked).padStart(5)}건  (${pct(blocked, p)})`)
    console.log(`  too_short ${String(too_short).padStart(5)}건  (${pct(too_short, p)})`)
    console.log(`  not_found ${String(not_found).padStart(5)}건  (${pct(not_found, p)})`)
    console.log(`  timeout   ${String(timeout).padStart(5)}건  (${pct(timeout, p)})`)
    console.log(`  error     ${String(error).padStart(5)}건  (${pct(error, p)})`)
  }

  if (filterStats?.processed) {
    const { processed: p, high, medium, low } = filterStats
    console.log(`\n[Rule Filter]  ${p}건`)
    console.log(`  high   ${String(high).padStart(5)}건  (${pct(high, p)})`)
    console.log(`  medium ${String(medium).padStart(5)}건  (${pct(medium, p)})`)
    console.log(`  low    ${String(low).padStart(5)}건  (${pct(low, p)})`)
  }

  if (dumpStats?.processed) {
    const {
      processed: p,
      directLinks,
      wrongLotSkipped,
      mediumCandidates,
      candidatesFile,
      candidatesFiles,
    } = dumpStats
    const chunkCount = candidatesFiles?.length ?? 1
    console.log(`\n[Match Dump]  ${p}건`)
    console.log(`  직접 INSERT   ${directLinks}건  (rule=high & match=high)`)
    console.log(`  wrong_lot skip ${wrongLotSkipped}건  (lot name not in full_text)`)
    console.log(
      `  medium → AI   ${mediumCandidates}건 (${chunkCount}개 청크, 각 최대 50건) → ${candidatesFile}`,
    )
    if (mediumCandidates > 0) {
      console.log(`\n  → 다음: haiku subagent ${chunkCount}개 병렬 실행 후`)
      console.log(
        `    bun run scripts/run-pipeline-149.ts --remote --stage match-apply --ai-results ${candidatesFile} --out ${tmpDir}`,
      )
    }
  }

  if (applyStats) {
    const { aiTotal, aiPassed, removalBreakdown } = applyStats
    console.log(`\n[Match Apply (AI)]  ${aiTotal}건 평가`)
    console.log(`  통과  ${aiPassed}건  (${pct(aiPassed, aiTotal)})`)
    console.log(`  제거  ${aiTotal - aiPassed}건`)
    for (const [reason, count] of Object.entries(removalBreakdown).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${reason.padEnd(14)} ${count}건`)
    }
  }

  if (emittedFiles.length > 0) {
    console.log(`\n[SQL Files]  ${tmpDir}`)
    for (const f of emittedFiles) console.log(`  ${f.split('/').pop()}`)

    if (APPLY) {
      if (APPLY === 'local' || APPLY === 'remote' || APPLY === 'both')
        applySqlFiles('local', emittedFiles)
      if (APPLY === 'remote' || APPLY === 'both') applySqlFiles('remote', emittedFiles)
      console.log('\n✅ 완료')
    } else {
      console.log('\n💡 적용:')
      console.log(`   bun run scripts/run-pipeline-149.ts --remote --apply local  --out ${tmpDir}`)
      console.log(`   bun run scripts/run-pipeline-149.ts --remote --apply remote --out ${tmpDir}`)
    }
  }
  console.log()
}

main().catch((err) => {
  console.error('\n❌ 에러:', err.message)
  process.exit(1)
})
