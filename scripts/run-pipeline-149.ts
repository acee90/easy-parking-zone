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
  scoreBlogRelevance,
  stripHtml,
} from '../src/server/crawlers/lib/scoring'
import { d1Query, isRemote, localDbPath } from './lib/d1'
import { classify, NOISE_TYPES, normalizeName } from './lib/missed-classify'
import { searchNaverLocal } from './lib/naver-api'
import {
  type ExistingLot,
  extractHints,
  isRelevant,
  loadExistingLots,
  resolvePlace,
} from './lib/place-match'
import { esc, sqlVal } from './lib/sql-flush'

// 추출된 장소명이 노이즈(지역명/일반명/페이지·서비스명/추출 파편)면 missed로 보내지 않는다.
// missed 정화 트랙: 미래 크롤이 이미-DB-있는 lot/노이즈로 missed를 재오염하지 않게 함.
function isNoiseLotName(name: string): boolean {
  return NOISE_TYPES.has(classify(normalizeName(name)).type)
}

// ── 좌표회수 lot-match (--coord-recovery, opt-in) ───────────────────
// 이름매칭(pickBestLot) 실패 시 장소검색 좌표로 기존 lot 회수. eval 검증: recall 5%→92%.
// API 비용(실패 raw당 Naver 1콜)이 있어 기본 off, 플래그로만 활성.
const COORD_RECOVERY = process.argv.includes('--coord-recovery')
const COORD_RECOVERY_RADIUS_M = 60
let _coordLots: ExistingLot[] | null = null
let _lotByIdCache: Map<string, LotRow> | null = null

async function recoverLotByCoordinate(
  name: string,
  title: string,
  content: string,
): Promise<{ lot: LotRow; score: number } | null> {
  if (!_coordLots) _coordLots = loadExistingLots()
  if (!_lotByIdCache) _lotByIdCache = new Map(loadAllLots().map((l) => [l.lot_id, l]))
  const query = /(주차장|파킹|parking)/i.test(name) ? name : `${name} 주차장`
  let items
  try {
    items = await searchNaverLocal(query, 5)
  } catch {
    return null
  }
  const hints = extractHints(`${title} ${content}`)
  const o = resolvePlace(name, items, _coordLots, hints, COORD_RECOVERY_RADIUS_M)
  if (o.label !== 'all_existing' || !o.best?.existing_lot_id) return null
  // 관련성 게이트: Naver 결과명/지역 기반 (DB lot명 기반 아님 — 좌표회수는 이름이 다른 경우용).
  // "서울"→롯데월드 같은 우연 매칭은 결과명·지역 불일치로 차단.
  if (!isRelevant(name, o.best)) return null
  const lot = _lotByIdCache.get(o.best.existing_lot_id)
  if (!lot) return null
  const score = scoreBlogRelevance(title, content, lot.name, lot.address)
  return { lot, score }
}

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
// --all-to-ai: rule=high여도 direct insert 비활성화, 모든 후보 AI 위임 (eval용)
const ALL_TO_AI = args.includes('--all-to-ai')

// --remote 없이도 .wrangler/state/v3/d1 에서 로컬 DB 자동 탐색

if (
  !['fulltext-fetch', 'filter', 'ai-filter', 'lot-match', 'match-dump', 'match-apply', ''].includes(
    STAGE,
  )
) {
  console.error(
    `⚠️  알 수 없는 stage: "${STAGE}". fulltext-fetch | filter | ai-filter | lot-match | match-dump | match-apply 중 선택.`,
  )
  process.exit(1)
}

if ((STAGE === 'match-apply' || STAGE === 'lot-match') && !AI_RESULTS_FILE) {
  console.error(`⚠️  ${STAGE}는 --ai-results FILE 필요.`)
  process.exit(1)
}

// ── 상수 ──────────────────────────────────────────────────────────

const FTS_LIMIT = 5
// lot명에서 식별력 없는 일반 토큰 — 후보 스코어링의 핵심 토큰 산정에서 제외
const LOT_GENERIC = new Set([
  '주차장',
  '주차',
  '공영',
  '민영',
  '노상',
  '노외',
  '무료',
  '유료',
  '부설',
  '임시',
  '기계식',
])
const SQL_CHUNK_SIZE = 300
const DB_NAME = 'parking-db'
const MAX_FULLTEXT_BYTES = 30_000
const CRAWL4AI_URL = argVal('--crawl4ai-url') ?? 'https://crawl.arttoken.biz'
const C4AI_TIMEOUT_MS = 15_000
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
  /** lot-specific 200~600자 요약. filter_passed=false면 빈 문자열. */
  summary?: string
}

// ── full_text 기반 lot_name 존재 여부 체크 ─────────────────────────

export function lotNameInFullText(lotName: string, fullText: string, title: string = ''): boolean {
  const keywords = extractNameKeywords(lotName)
  const text = (title + ' ' + fullText).toLowerCase()
  const textNoSpace = text.replace(/\s+/g, '')

  // 전체 이름 키워드(keywords[0])가 3자 이상이면 그것만으로 통과 판정
  const fullNameKw = keywords[0]
  if (fullNameKw && fullNameKw.length >= 3) {
    // 1) 원본 substring
    if (text.includes(fullNameKw)) return true
    // 2) 공백 무시 substring (예: "스타필드시티위례"가 본문에 있을 때)
    const fullNameNoSpace = fullNameKw.replace(/\s+/g, '')
    if (fullNameNoSpace.length >= 4 && textNoSpace.includes(fullNameNoSpace)) return true
    // 3) 어순 뒤집은 합성 (예: "위례스타필드시티")
    const parts = fullNameKw.split(/\s+/).filter((p) => p.length >= 2)
    if (parts.length >= 2) {
      const reversed = [...parts].reverse().join('')
      if (reversed.length >= 4 && textNoSpace.includes(reversed)) return true
      // 4) 모든 part가 본문에 출현 (어순 무관, 거리 무관)
      if (parts.every((p) => textNoSpace.includes(p))) return true
    }
  }

  // 그 외: 길이 3 이상 키워드 중 2개 이상 포함 여부 확인 (공백 무시 포함)
  const longKws = keywords.filter((kw) => kw.length >= 3)
  const matchCount = longKws.filter(
    (kw) => text.includes(kw) || textNoSpace.includes(kw.replace(/\s+/g, '')),
  ).length
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
  // 블로그 제목 필러 — 장소명이 아닌 머리말/수식어 (place name이 뒤로 밀려 누락되는 주원인)
  '여행',
  '가기',
  '좋은',
  '함께',
  '나의',
  '다녀와서',
  '다녀온',
  '다녀왔어요',
  '아이랑',
  '아이들과',
  '가족여행',
  '나들이',
  '당일치기',
  '둘러보기',
  '방문기',
  '방문',
  '코스',
  '명소',
  '인근',
  '예약',
  '갈만한',
  '갈만한곳',
  '가볼만한',
  '주말',
  // 주차장 유형 수식어 — lot name에 포함돼도 너무 범용적 (공영주차장 등)
  '공영',
  '민영',
  '노상',
  '노외',
  '부설',
  '임시',
  '기계식',
])

export function extractSearchKeywords(title: string, content: string): string[] {
  // Primary: words before '주차장' in title
  if (title.includes('주차장')) {
    const parkingIdx = title.indexOf('주차장')
    const beforeParking = title.slice(0, parkingIdx).trim()
    const words = beforeParking
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 2 && !STOP_WORDS.has(w) && !/^\d+$/.test(w))
    const unique = [...new Set(words)]
    // 선두(보통 장소명) + 말미(주차장 직전) 토큰을 함께 보존.
    // slice(-3)만 쓰면 "스타필드 시티 위례 … 다이소 주차장"에서 장소명을 통째로 잃음.
    const candidates = [...new Set([...unique.slice(0, 3), ...unique.slice(-3)])]
    if (candidates.length > 0 && candidates.some((w) => w.length >= 2)) return candidates
  }

  // Fallback 1: strip parking keywords from title, extract remaining
  const titleCleaned = title
    .replace(/주차장|주차/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w) && !/^\d+$/.test(w))
  const titleUnique = [...new Set(titleCleaned)]
  // 장소명은 보통 가장 긴 복합명사(김제시립도서관/양구선사박물관/과천과학관).
  // 앞 N개 컷은 "아이들과 함께 가기 좋은 …" 같은 필러 머리말을 잡아 장소명을 잃음.
  // → 길이 내림차순 우선 선택으로 식별력 높은 토큰 보존.
  if (titleUnique.length > 0)
    return [...titleUnique].sort((a, b) => b.length - a.length).slice(0, 5)

  // Fallback 2: extract from content snippet (covers "XX 방문기" titles with parking in body)
  const contentCleaned = content
    .slice(0, 300)
    .replace(/주차장|주차/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w) && !/^\d+$/.test(w))
  const contentUnique = [...new Set(contentCleaned)]
  if (contentUnique.length === 0) return []
  return [...contentUnique].sort((a, b) => b.length - a.length).slice(0, 5)
}

// 추출 키워드가 lot name과 지리적으로 연관있는지 판정.
// every()는 본문 노이즈 키워드(CGV/맛집/1탄 등)가 섞이면 정답 lot도 탈락시킴.
// → 공백 무시 정규화 + (다중 토큰 일치 | 이름 변형 일치 | 식별적 장문 토큰) 기준으로 완화.
// 정밀도는 하류 lotNameInFullText + getMatchConfidence + AI filter가 담당.
export function isCandidateLocationCompatible(keywords: string[], lot: LotRow): boolean {
  const kws = keywords.map((k) => k.toLowerCase()).filter((k) => k.length >= 2)
  if (kws.length === 0) return false
  const nameNoSpace = lot.name.toLowerCase().replace(/\s+/g, '')

  const joined = kws.join('')
  const reversed = [...kws].reverse().join('')
  if (
    joined.length >= 4 &&
    (nameNoSpace.includes(joined) ||
      joined.includes(nameNoSpace) ||
      (reversed.length >= 4 && nameNoSpace.includes(reversed)))
  )
    return true

  // lot명 핵심 토큰이 키워드 blob에 모두 등장하면 통과 (어순·공백 무관)
  const coreTokens = lot.name
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((t) => t.length >= 2 && !LOT_GENERIC.has(t))
  if (coreTokens.length > 0) {
    const hit = coreTokens.filter(
      (t) => joined.includes(t) || kws.some((k) => k.includes(t) || t.includes(k)),
    ).length
    if (hit === coreTokens.length || hit >= 2) return true
  }

  const matched = kws.filter((kw) => nameNoSpace.includes(kw.replace(/\s+/g, '')))
  // 다중 토큰 일치 → 단일 흔한 토큰(브랜드) 오매칭 방지하며 통과
  if (matched.length >= 2) return true
  // 단일이라도 충분히 식별적인 장문 토큰이면 통과
  if (matched.some((kw) => kw.length >= 4)) return true
  return false
}

// 인메모리 lot 캐시 — runMatchDumpStage() 시작 시 한 번만 로드
let _allLots: LotRow[] | null = null

export function loadAllLots(): LotRow[] {
  if (_allLots) return _allLots
  console.log('  📦 parking_lots 전체 로드 중...')
  _allLots = d1Query<LotRow>(
    "SELECT id AS lot_id, name, address FROM parking_lots WHERE status != 'inactive' OR status IS NULL",
  )
  console.log(`  📦 ${_allLots.length}개 lot 캐시 완료`)
  return _allLots
}

// 관련도 랭킹 기반 후보 생성. 단순 선형 스캔 + 앞 N개 컷(이름 변형/흔한 토큰에
// 슬롯을 뺏겨 정작 정답 lot이 후보에 못 드는 문제)을 스코어 정렬로 교체.
export function searchCandidateLots(keywords: string[], allLots: LotRow[]): LotRow[] {
  if (keywords.length === 0) return []
  const kws = keywords.map((kw) => kw.toLowerCase()).filter((kw) => kw.length >= 2)
  if (kws.length === 0) return []
  // 공백 무시 합성(이름 변형 매칭): "스타필드시티위례" / 어순 뒤집기 흡수
  const joinedNoSpace = kws.join('')
  const reversedNoSpace = [...kws].reverse().join('')

  const scored: Array<{ lot: LotRow; score: number }> = []
  for (const lot of allLots) {
    const name = lot.name.toLowerCase()
    const addr = lot.address.toLowerCase()
    const nameNoSpace = name.replace(/\s+/g, '')
    let score = 0
    for (const kw of kws) {
      const kwNoSpace = kw.replace(/\s+/g, '')
      // 길이 가중: 식별력 높은 장문 토큰(스타필드시티위례)이 흔한 단문 토큰(cgv/시티)을 압도
      if (name.includes(kw) || nameNoSpace.includes(kwNoSpace))
        score += Math.min(kwNoSpace.length, 8)
      if (addr.includes(kw)) score += 1
    }
    // lot명 핵심 토큰 커버리지(어순·공백 무관): "위례스타필드시티" ↔ "스타필드시티 위례"
    const coreTokens = name
      .split(/\s+/)
      .map((t) => t.replace(/[^\p{L}\p{N}]/gu, ''))
      .filter((t) => t.length >= 2 && !LOT_GENERIC.has(t))
    if (coreTokens.length > 0) {
      const hit = coreTokens.filter(
        (t) => joinedNoSpace.includes(t) || kws.some((k) => k.includes(t) || t.includes(k)),
      ).length
      if (hit === coreTokens.length && coreTokens.join('').length >= 4) score += 14
      else if (hit >= 2) score += 8
    }
    // 이름 변형(공백 제거/어순) 보조 신호
    if (joinedNoSpace.length >= 4) {
      if (nameNoSpace.includes(joinedNoSpace) || joinedNoSpace.includes(nameNoSpace)) score += 6
      else if (reversedNoSpace.length >= 4 && nameNoSpace.includes(reversedNoSpace)) score += 6
    }
    if (score > 0) scored.push({ lot, score })
  }
  // 스코어 내림차순 정렬 후 상위 FTS_LIMIT개 (앞 N개 임의 컷 → 최상위 N개)
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, FTS_LIMIT).map((s) => s.lot)
}

// ── INSERT SQL 생성 ───────────────────────────────────────────────

function buildMissedLotInsertSql(raw: RawRow, detectedName: string): string {
  // full_text는 web_sources_raw에서만 관리 (raw_source_id로 JOIN 조회).
  // web_sources_missed는 정제 데이터만 보유 — web_sources와 동일 원칙.
  const cols = [
    'missed_lot_name',
    'source',
    'source_id',
    'title',
    'content',
    'source_url',
    'author',
    'published_at',
    'raw_source_id',
    'sentiment_score',
    'ai_difficulty_keywords',
  ]
  const vals = [
    detectedName,
    raw.source,
    raw.source_id,
    stripHtml(raw.title),
    stripHtml(raw.content),
    raw.source_url,
    raw.author,
    raw.published_at,
    raw.id,
    raw.sentiment_score,
    raw.ai_difficulty_keywords,
  ]
    .map(sqlVal)
    .join(', ')

  return `INSERT OR IGNORE INTO web_sources_missed (${cols.join(', ')}) VALUES (${vals});`
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

  // ai_summary: pipeline-ai-filter agent가 통합 단계에서 직접 생성. 빈 문자열이면 '시도했으나 실패'로 마킹.
  const aiSummary = aiResult?.summary ?? null
  // sqlVal이 SQL 키워드를 못 다루므로 ISO 문자열로 시각 기록 (SQLite TEXT 호환)
  const aiSummaryUpdatedAt = aiSummary !== null ? new Date().toISOString() : null

  // full_text는 web_sources_raw에서만 관리 (raw_source_id로 JOIN하여 조회).
  // web_sources는 정제된 데이터(summary/sentiment/관계)만 보유.
  // ai-filter(v3 품질판정)를 통과한 글만 buildInsertSql에 도달하므로 filter_passed_v2=1.
  // compute-parking-stats의 web_score 집계 조건(filter_passed_v2=1)을 충족시켜 점수에 반영.
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
    'ai_summary_updated_at',
    'filter_passed_v2',
    'filter_v2_reason',
    'filter_v2_evaluated_at',
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
    aiSummary,
    aiSummaryUpdatedAt,
    1,
    'ai_pass',
    new Date().toISOString(),
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
    // remote에 push 시 이미 처리된 row(status≠'pending')는 덮어쓰지 않도록 가드.
    // local-pending 모드에서 local·remote 가 divergent 인 경우 (remote가 더 진척) 안전장치.
    return `UPDATE web_sources_raw SET full_text = ${fullTextVal}, full_text_status = '${status}', full_text_fetched_at = datetime('now') WHERE id = ${id} AND full_text_status = 'pending';`
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

  // ID만 먼저 가져와서 총 대상 확인 (full_text 없이 → 응답 작음)
  const idRows = d1Query<{ id: number }>(
    `SELECT id FROM web_sources_raw WHERE filter_passed = 1 AND matched_at IS NULL ORDER BY id LIMIT ${LIMIT}`,
  )
  console.log(`  대상: ${idRows.length}건`)
  if (idRows.length === 0)
    return { processed: 0, directLinks: 0, wrongLotSkipped: 0, mediumCandidates: 0 }

  const allLots = loadAllLots()

  // ID 목록을 200건씩 배치로 나눠 full_text 포함 fetch (D1 응답 크기 한도 회피)
  const FETCH_BATCH = 200
  const allIds = idRows.map((r) => r.id)
  const rows: RawRow[] = []
  for (let b = 0; b < allIds.length; b += FETCH_BATCH) {
    const batchIds = allIds.slice(b, b + FETCH_BATCH).join(',')
    const batch = d1Query<RawRow>(
      `SELECT id, source, source_id, source_url, title, content, author, published_at,
              sentiment_score, ai_difficulty_keywords,
              full_text, full_text_status, full_text_fetched_at, filter_tier
       FROM web_sources_raw WHERE id IN (${batchIds})`,
    )
    rows.push(...batch)
    process.stdout.write(`\r  rows 로드: ${rows.length}/${allIds.length}`)
  }
  console.log()

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
    const candidates = searchCandidateLots(keywords, allLots)

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

    // rule classifier high가 엄격화돼(concrete parking distinct≥2) 신뢰 가능 →
    // strict-high & match=high는 AI 스킵 direct insert, 그 외는 medium(AI 판정).
    for (const { lot, score } of highMatches) {
      if (isRuleHigh && !ALL_TO_AI) {
        directInserts.push(buildInsertSql(raw, lot, score, null))
        directLinks++
      } else {
        mediumMatches.push({ lot, score })
      }
    }

    for (const { lot, score } of mediumMatches) {
      if (isRuleHigh && !ALL_TO_AI) {
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
        if (isNoiseLotName(detectedName)) {
          // 노이즈 장소명 → missed 적재하지 않고 raw만 마킹 (missed 재오염 방지)
          directUpdates.push(
            `UPDATE web_sources_raw SET matched_at = datetime('now'), match_fail_reason = 'noise_name' WHERE id = ${raw.id};`,
          )
          immediateMatchedIds.add(raw.id)
        } else {
          missedInserts.push(buildMissedLotInsertSql(raw, detectedName))
          missedUpdates.push(
            `UPDATE web_sources_raw SET matched_at = datetime('now'), match_fail_reason = 'lot_not_in_db' WHERE id = ${raw.id};`,
          )
          missedLotCount++
          immediateMatchedIds.add(raw.id)
        }
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

  // raw 데이터 재조회 (통과 항목만, 200건씩 배치 — D1 응답 크기 한도 회피)
  const uniqueIds = [...new Set(passingIds)]
  const FETCH_BATCH = 200
  const rawRows: RawRow[] = []
  for (let b = 0; b < uniqueIds.length; b += FETCH_BATCH) {
    const batchIds = uniqueIds.slice(b, b + FETCH_BATCH).join(', ')
    const batch = d1Query<RawRow>(
      `SELECT id, source, source_id, source_url, title, content, author, published_at,
              sentiment_score, ai_difficulty_keywords,
              full_text, full_text_status, full_text_fetched_at, filter_tier
       FROM web_sources_raw WHERE id IN (${batchIds})`,
    )
    rawRows.push(...batch)
  }
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

// ── Stage 2 (재배치): ai-filter 입력 dump — lot 없음 ──────────────
// plan §4.1: rule 통과(high+medium) raw를 lot 모른 채 콘텐츠 품질/요약 평가용으로 dump.
async function runAiFilterDumpStage() {
  console.log('\n🧪 Stage: ai-filter (dump, lot-less)')
  // full_text_status='ok' 가드: purge로 full_text가 비워진 row(zombie)는 본문이 없어
  // AI 품질판정이 불가능하므로 dump 대상에서 제외한다. 가드가 없으면 purged-unmatched
  // row가 매 라운드 재dump되어 subagent 호출을 낭비한다.
  const idRows = d1Query<{ id: number }>(
    `SELECT id FROM web_sources_raw WHERE filter_passed = 1 AND matched_at IS NULL AND full_text_status = 'ok' ORDER BY id LIMIT ${LIMIT}`,
  )
  console.log(`  대상: ${idRows.length}건`)
  if (idRows.length === 0)
    return { processed: 0, candidatesFile: '', candidatesFiles: [] as string[] }

  const FETCH_BATCH = 200
  const allIds = idRows.map((r) => r.id)
  const rows: RawRow[] = []
  for (let b = 0; b < allIds.length; b += FETCH_BATCH) {
    const batch = d1Query<RawRow>(
      `SELECT id, source, source_id, source_url, title, content, author, published_at,
              sentiment_score, ai_difficulty_keywords,
              full_text, full_text_status, full_text_fetched_at, filter_tier
       FROM web_sources_raw WHERE id IN (${allIds.slice(b, b + FETCH_BATCH).join(',')})`,
    )
    rows.push(...batch)
  }

  // lot-less 후보: 에이전트는 lot 모르고 콘텐츠 품질 + lot-agnostic summary만 생성
  const candidates = rows.map((raw) => ({
    raw_id: raw.id,
    title: stripHtml(raw.title),
    full_text: (raw.full_text ?? stripHtml(raw.content)).slice(0, 6000),
  }))

  const CHUNK_SIZE = 20
  const chunkCount = Math.ceil(candidates.length / CHUNK_SIZE)
  const candidatesFiles: string[] = []
  for (let i = 0; i < chunkCount; i++) {
    const chunk = candidates.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)
    const suffix = chunkCount > 1 ? `-${String(i + 1).padStart(2, '0')}` : ''
    const f = `${tmpDir}/medium-candidates${suffix}.json`
    writeFileSync(
      f,
      JSON.stringify({ candidates: chunk, generated_at: new Date().toISOString() }, null, 2),
      'utf-8',
    )
    candidatesFiles.push(f)
    console.log(`  → ${f.split('/').pop()} (${chunk.length}건)`)
  }
  return { processed: rows.length, candidatesFile: candidatesFiles[0], candidatesFiles }
}

// ── Stage 3 (재배치): lot-match — ai-filter 통과 글에 best lot 매칭 ──
const missedInsertsLM: string[] = []

// (B) lot 식별코어 게이트: lot명에서 generic/숫자 제거 후 식별 토큰(≥4자)이
// 본문에 실제 등장해야 통과. 식별 토큰이 없으면(지역명·범용명뿐) 코어 전체
// 결합문자열 일치 요구. 지역-only/스침 언급 오매칭(강진군립도서관·구좌읍주차장
// ·베스트주차장 등)을 차단하면서 정답(김제시립도서관 등)은 보존.
export function lotCoreInText(lotName: string, title: string, fullText: string): boolean {
  const hay = (title + ' ' + fullText).toLowerCase().replace(/\s+/g, '')
  const core = lotName
    .toLowerCase()
    .replace(/주차장\s*\d*/g, ' ')
    .replace(/주차\s*\d*/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}]/gu, '').replace(/\d+$/, ''))
    .filter((t) => t.length >= 2 && !LOT_GENERIC.has(t))
  if (core.length === 0) return false
  const distinct = core.filter((t) => t.length >= 4)
  if (distinct.length > 0) return distinct.some((t) => hay.includes(t))
  const joined = core.join('')
  return joined.length >= 4 && hay.includes(joined)
}

export function pickBestLot(
  title: string,
  content: string,
  fullText: string,
): { lot: LotRow; score: number } | null {
  const keywords = extractSearchKeywords(title, content)
  if (keywords.length === 0) return null
  const candidates = searchCandidateLots(keywords, loadAllLots())
  const rank: Record<string, number> = { high: 3, medium: 2, none: 1 }
  let best: { lot: LotRow; score: number; r: number } | null = null
  for (const lot of candidates) {
    if (!isCandidateLocationCompatible(keywords, lot)) continue
    if (fullText.length > 200 && !lotNameInFullText(lot.name, fullText, title)) continue
    if (!lotCoreInText(lot.name, title, fullText)) continue
    const { score, confidence } = getMatchConfidence(title, content, lot.name, lot.address)
    const r = rank[confidence] ?? 0
    if (!best || r > best.r || (r === best.r && score > best.score)) best = { lot, score, r }
  }
  return best ? { lot: best.lot, score: best.score } : null
}

async function runLotMatchStage() {
  console.log('\n🎯 Stage: lot-match')
  if (!AI_RESULTS_FILE || !existsSync(AI_RESULTS_FILE)) {
    console.error(`⚠️  AI 결과 파일 없음: ${AI_RESULTS_FILE}`)
    process.exit(1)
  }
  const resultsDir = AI_RESULTS_FILE.replace(/\/[^/]+$/, '')
  const { readdirSync } = await import('node:fs')
  const files = readdirSync(resultsDir)
    .filter((f) => f.startsWith('ai-results') && f.endsWith('.json'))
    .sort()
    .map((f) => `${resultsDir}/${f}`)
  const results: AiResult[] = []
  for (const file of files) {
    const { results: rs } = JSON.parse(readFileSync(file, 'utf-8')) as { results: AiResult[] }
    results.push(...rs)
  }
  console.log(`  AI 결과 ${results.length}건 (파일 ${files.length}개)`)

  const passing = results.filter((r) => r.filter_passed)
  const uniqueIds = [...new Set(passing.map((r) => r.raw_id))]
  const FETCH_BATCH = 200
  const rawRows: RawRow[] = []
  for (let b = 0; b < uniqueIds.length; b += FETCH_BATCH) {
    const batch = d1Query<RawRow>(
      `SELECT id, source, source_id, source_url, title, content, author, published_at,
              sentiment_score, ai_difficulty_keywords,
              full_text, full_text_status, full_text_fetched_at, filter_tier
       FROM web_sources_raw WHERE id IN (${uniqueIds.slice(b, b + FETCH_BATCH).join(',')})`,
    )
    rawRows.push(...batch)
  }
  const rawById = new Map(rawRows.map((r) => [r.id, r]))

  const inserts: string[] = []
  const updates: string[] = []
  let matched = 0
  let recovered = 0
  let missed = 0
  for (const result of results) {
    if (!result.filter_passed) continue
    const raw = rawById.get(result.raw_id)
    if (!raw) continue
    const title = stripHtml(raw.title)
    const content = stripHtml(raw.content)
    const fullText = raw.full_text ?? content
    const best = pickBestLot(title, content, fullText)
    if (best) {
      inserts.push(buildInsertSql(raw, best.lot, best.score, result))
      matched++
      continue
    }
    // 이름매칭 실패 — 노이즈명이면 버리고, 아니면 좌표회수 시도 후 missed
    const detectedName = extractSearchKeywords(title, content).join(' ')
    if (isNoiseLotName(detectedName)) continue
    if (COORD_RECOVERY) {
      const rec = await recoverLotByCoordinate(detectedName, title, content)
      if (rec) {
        inserts.push(buildInsertSql(raw, rec.lot, rec.score, result))
        recovered++
        continue
      }
    }
    missedInsertsLM.push(buildMissedLotInsertSql(raw, detectedName))
    missed++
  }
  if (COORD_RECOVERY) console.log(`  🧭 좌표회수 매칭: ${recovered}건`)
  // 모든 AI 평가 raw에 matched_at 마킹 (재처리 방지)
  for (const rawId of new Set(results.map((r) => r.raw_id))) {
    updates.push(`UPDATE web_sources_raw SET matched_at = datetime('now') WHERE id = ${rawId};`)
  }
  const all = [...inserts, ...missedInsertsLM, ...updates]
  for (let i = 0; i < all.length; i += SQL_CHUNK_SIZE) {
    emitSqlChunk('match-ai', all.slice(i, i + SQL_CHUNK_SIZE))
  }
  return { aiTotal: results.length, aiPassed: passing.length, matched, recovered, missed }
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
  let aiFilterStats: Awaited<ReturnType<typeof runAiFilterDumpStage>> | null = null
  let lotMatchStats: Awaited<ReturnType<typeof runLotMatchStage>> | null = null

  if (STAGE === 'fulltext-fetch') fetchStats = await runFullTextFetchStage()
  if (STAGE === 'filter') filterStats = await runFilterStage()
  if (STAGE === 'ai-filter') aiFilterStats = await runAiFilterDumpStage()
  if (STAGE === 'lot-match') lotMatchStats = await runLotMatchStage()
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

  if (aiFilterStats?.processed) {
    const { processed, candidatesFiles } = aiFilterStats
    console.log(`\n[AI Filter Dump]  ${processed}건 → ${candidatesFiles.length}개 청크 (lot-less)`)
    console.log(`  → haiku subagent 실행 후: --stage lot-match --ai-results <dir>/ai-results*.json`)
  }

  if (lotMatchStats) {
    const { aiTotal, aiPassed, matched, recovered, missed } = lotMatchStats
    console.log(`\n[Lot Match]  AI ${aiTotal}건 / 통과 ${aiPassed}건`)
    console.log(`  매칭   ${matched}건  (${pct(matched, aiPassed)})`)
    if (recovered > 0) console.log(`  좌표회수 ${recovered}건  (이름매칭 실패 → 좌표로 기존 lot)`)
    console.log(`  missed ${missed}건  (lot DB에 없음)`)
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

if (import.meta.main) {
  main().catch((err) => {
    console.error('\n❌ 에러:', err.message)
    process.exit(1)
  })
}
