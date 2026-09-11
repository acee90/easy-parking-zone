/**
 * 주차장 하이브리드 매칭 모듈 (Workers Cron용)
 *
 * filter_passed=1인 web_sources_raw를 FTS5로 후보 검색 후:
 *   - rule=high & match=high: AI 없이 바로 저장
 *   - 그 외 (rule=medium 또는 match=medium): lot_name + full_text로 AI 품질 판정 후 저장
 *   - low/none: 스킵
 *
 * 연결된 raw 는 이 자리에서 **글 요약(web_sources.ai_summary)** 도 만든다.
 * 여기서 하는 이유는 본문이 손 안에 있기 때문이다 — 크론 6단계 purge 가 매칭 끝난 행의
 * 본문을 지우므로, 요약을 나중 단계나 별도 크론으로 미루면 본문이 이미 없다.
 *
 * ⚠️ 이 모듈은 크론 한 번(wall 15분) 안에서 돈다. AI 호출이 건당 최대 120초라
 *    상한 50건을 그대로 돌면 한도를 넘는다. 그래서
 *      (1) 남은 시간 예산을 보고 AI 호출을 멈추고,
 *      (2) 중간중간 DB 에 flush 한다 — 잘려도 그때까지 한 일은 남는다.
 */

import { enqueueScoreRecomputeBatch } from '@/server/queues/score-recompute'
import { callAiText, parseAiJson } from './lib/ai-client'
import {
  buildFilterV2UserPrompt,
  FILTER_V2_SYSTEM_PROMPT,
  type FilterV2Input,
  type FilterV2Output,
} from './lib/ai-filter-v2-prompt'
import { AI_SUMMARY_SYSTEM_PROMPT, MIN_SUMMARY_LENGTH } from './lib/ai-summary-prompt'
import { extractMissedLotName, isNoiseLotName } from './lib/missed-name'
import { getMatchConfidence, stripHtml } from './lib/scoring'
import { detectSummaryPollution } from './lib/summary-guard'

const MAX_PER_RUN = 50

/**
 * AI 호출에 쓸 시간 예산. 크론 wall 한도는 15분이고 앞뒤로 다른 단계가 있어
 * 매칭 단계는 6분까지만 쓴다. 예산을 넘기면 남은 raw 는 AI 없이 넘긴다
 * (matched_at 을 찍지 않으므로 다음 회차가 그대로 이어받는다).
 */
const AI_BUDGET_MS = 6 * 60 * 1000

/** 이 건수마다 DB 에 flush — 중간에 잘려도 여기까지는 남는다 */
const FLUSH_EVERY = 10
/** FTS 후보 최대 개수 */
const FTS_CANDIDATE_LIMIT = 20

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
  ai_summary: string | null
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

const STOP_WORDS = new Set([
  '주차장',
  '주차',
  '후기',
  '정보',
  '공유',
  '추천',
  '이용',
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
])

function extractSearchKeywords(title: string, content: string): string[] {
  const text = `${title} ${content}`.slice(0, 500)
  const words = text
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2 && w.length <= 15)
    .filter((w) => !STOP_WORDS.has(w))
    .filter((w) => !/^\d+$/.test(w))
  return [...new Set(words)].slice(0, 5)
}

/**
 * LIKE 폴백용 lot 캐시 — 배치 1회만 로드한다.
 *
 * 과거에는 폴백마다 `parking_lots WHERE name LIKE '%kw%'` 를 날렸는데, 선행 와일드카드라
 * 인덱스를 못 타고 31,994행 풀스캔이 된다(EXPLAIN: SCAN parking_lots). raw 50행 x 키워드
 * 3개면 회당 4.8M행, 하루 48회면 **230M행**으로 D1 rows_read 의 최대 소비처였다.
 * parking_lots 는 3만 행짜리 거의 변하지 않는 테이블이므로 한 번 읽어 메모리에서 거른다.
 * (회당 4.8M → 32k, 약 150배 감소)
 */
let lotCache: Array<LotRow & { nameLower: string }> | null = null

async function getLotCache(db: D1Database): Promise<Array<LotRow & { nameLower: string }>> {
  if (lotCache) return lotCache
  const rows = await db
    .prepare(`SELECT id AS lot_id, name, address FROM parking_lots`)
    .all<LotRow>()
  // SQLite LIKE 는 ASCII 대소문자를 구분하지 않는다 — includes 로 바꾸면서 동작을 맞춘다.
  lotCache = (rows.results ?? []).map((r) => ({ ...r, nameLower: r.name.toLowerCase() }))
  return lotCache
}

async function searchCandidateLots(db: D1Database, keywords: string[]): Promise<LotRow[]> {
  if (keywords.length === 0) return []

  const seen = new Set<string>()
  const results: LotRow[] = []

  // 1. FTS5 검색
  const ftsQuery = keywords.map((kw) => `"${kw}" OR ${kw}*`).join(' OR ')
  try {
    const ftsRows = await db
      .prepare(
        `SELECT lot_id, name, address FROM parking_lots_fts
         WHERE parking_lots_fts MATCH ?1 LIMIT ?2`,
      )
      .bind(ftsQuery, FTS_CANDIDATE_LIMIT)
      .all<LotRow>()

    for (const row of ftsRows.results ?? []) {
      if (!seen.has(row.lot_id)) {
        seen.add(row.lot_id)
        results.push(row)
      }
    }
  } catch {
    /* FTS 쿼리 실패 시 폴백으로 */
  }

  // 2. LIKE 폴백 — DB 쿼리 대신 메모리 캐시에서 거른다 (위 getLotCache 주석 참조)
  if (results.length < 3) {
    const lots = await getLotCache(db)
    for (const kw of keywords.slice(0, 3)) {
      if (kw.length < 2) continue
      const kwLower = kw.toLowerCase()
      let taken = 0
      const budget = FTS_CANDIDATE_LIMIT - results.length
      for (const row of lots) {
        if (taken >= budget) break
        if (!row.nameLower.includes(kwLower)) continue
        taken++
        if (!seen.has(row.lot_id)) {
          seen.add(row.lot_id)
          results.push(row)
        }
      }
      if (results.length >= FTS_CANDIDATE_LIMIT) break
    }
  }

  return results
}

export async function runMatchBatch(
  db: D1Database,
  env?: { UNSLOTH_API_KEY?: string; AI_MODEL?: string; AI_BASE_URL?: string },
): Promise<{
  matched: number
  lotLinks: number
  aiVerified: number
  /** AI 가 "이 주차장 글이 아니다"로 떨군 (raw, lot) 쌍 수 */
  aiRejected: number
  /** 거절 사유별 분포. 오염이 실제로 줄고 있는지 보려면 이 값이 필요하다 */
  rejectedBy: Record<string, number>
  summarized: number
  budgetExceeded: boolean
}> {
  const aiDeadline = Date.now() + AI_BUDGET_MS
  let budgetExceeded = false
  // 배치마다 lot 캐시를 비운다 — isolate 재사용 시 신규 주차장이 누락되지 않도록.
  // (배치 1회당 최대 1번 로드이므로 쿼리 절감 효과는 그대로다.)
  lotCache = null

  const rows = await db
    .prepare(
      // 본문은 web_sources_raw_body에 분리 저장 (0048) — JOIN으로 조회한다.
      `SELECT r.id, r.source, r.source_id, r.source_url, r.title, r.content, r.author, r.published_at,
              r.sentiment_score, r.ai_difficulty_keywords, r.ai_summary,
              b.body AS full_text, r.full_text_status, r.full_text_fetched_at, r.filter_tier
       FROM web_sources_raw r
       LEFT JOIN web_sources_raw_body b ON b.raw_id = r.id
       WHERE r.filter_passed = 1 AND r.matched_at IS NULL
       ORDER BY r.id
       LIMIT ?1`,
    )
    .bind(MAX_PER_RUN)
    .all<RawRow>()

  const sources = rows.results ?? []
  if (sources.length === 0) {
    return {
      matched: 0,
      lotLinks: 0,
      aiVerified: 0,
      aiRejected: 0,
      rejectedBy: {},
      summarized: 0,
      budgetExceeded: false,
    }
  }

  const insertBatch: D1PreparedStatement[] = []
  const updateBatch: D1PreparedStatement[] = []
  // 새 근거가 붙은 lot — 배치 반영 후 평점 재계산 + 종합 요약 재생성 판정 큐로 보낸다
  const touchedLots = new Set<string>()
  let matched = 0
  let lotLinks = 0
  let aiVerified = 0
  let aiRejected = 0
  let summarized = 0
  // 거절을 세지 않으면 수정 효과를 신규 행에서 확인할 방법이 없다. 행으로 남기지는
  // 않는다 — 위키·사이트맵 질의가 `relevance_score` 만 보고 `filter_passed_v2` 를
  // 안 보기 때문에, 거절 행을 넣으면 그대로 노출된다.
  const rejectedBy: Record<string, number> = {}
  let processedSinceFlush = 0

  // flush 는 쓰기와 큐 투입을 **같이** 한다.
  // 큐 투입을 루프 끝으로 미루면, 시간 예산에 걸려 중간에 나올 때 이미 쓴 행이
  // 큐에 안 들어간다 (크론 5단계가 그걸 뒤늦게 줍긴 하지만 두 시간 뒤다).
  const flush = async () => {
    const pending = [...insertBatch, ...updateBatch]
    insertBatch.length = 0
    updateBatch.length = 0
    if (pending.length === 0) return
    const D1_BATCH_LIMIT = 500
    for (let i = 0; i < pending.length; i += D1_BATCH_LIMIT) {
      await db.batch(pending.slice(i, i + D1_BATCH_LIMIT))
    }

    const lots = [...touchedLots]
    touchedLots.clear()
    if (lots.length > 0) {
      await enqueueScoreRecomputeBatch(
        lots.map((lotId) => ({ lotId, reason: 'web_source_matched' as const })),
      )
    }
  }

  for (const raw of sources) {
    // 시간 예산을 넘겼으면 여기서 멈춘다. 남은 raw 는 matched_at 이 그대로라
    // 다음 회차가 이어받는다 (일감이 사라지지 않는다).
    if (Date.now() >= aiDeadline) {
      budgetExceeded = true
      break
    }

    const title = stripHtml(raw.title)
    const content = stripHtml(raw.content)
    let thisItemLinked = 0

    // 1. FTS로 후보 검색
    const keywords = extractSearchKeywords(title, content)
    const candidates = await searchCandidateLots(db, keywords)

    // 2. 후보별 신뢰도 판정
    const highMatches: Array<{ lot: LotRow; score: number }> = []
    const mediumMatches: Array<{ lot: LotRow; score: number }> = []

    for (const lot of candidates) {
      const { score, confidence } = getMatchConfidence(title, content, lot.name, lot.address)
      if (confidence === 'high') {
        highMatches.push({ lot, score })
      } else if (confidence === 'medium') {
        mediumMatches.push({ lot, score })
      }
    }

    // 이 raw 에 연결될 (lot, 점수, AI 판정) 목록. 요약을 만든 뒤에 한꺼번에 INSERT 로 만든다.
    const links: Array<{ lot: LotRow; score: number; aiResult: FilterV2Output | null }> = []

    // 3. rule=high & match=high → AI 없이 바로 저장
    const isRuleHigh = raw.filter_tier === 'high'
    for (const { lot, score } of highMatches) {
      if (isRuleHigh) {
        links.push({ lot, score, aiResult: null })
      } else {
        mediumMatches.push({ lot, score })
      }
    }

    // 4. rule=medium 또는 match=medium → lot_name + full_text로 AI 판정
    if (mediumMatches.length > 0 && env?.UNSLOTH_API_KEY) {
      const inputs: FilterV2Input[] = mediumMatches.map(({ lot }) => ({
        id: raw.id,
        lot_name: lot.name,
        lot_address: lot.address,
        title,
        full_text: (raw.full_text ?? content).slice(0, 6000),
      }))

      try {
        const results = await callPostMatchFilter(
          inputs,
          env.UNSLOTH_API_KEY,
          env.AI_MODEL || undefined,
          env.AI_BASE_URL || undefined,
        )
        for (let j = 0; j < mediumMatches.length; j++) {
          const { lot, score } = mediumMatches[j]
          const aiResult = results[j]
          if (aiResult?.filter_passed) {
            links.push({ lot, score, aiResult })
            aiVerified++
          } else {
            aiRejected++
            const why = aiResult?.removed_by ?? 'no_result'
            rejectedBy[why] = (rejectedBy[why] ?? 0) + 1
          }
        }
      } catch (err) {
        console.log(`[match] AI verify error: ${(err as Error).message}`)
      }
    }

    // 5. 글 요약 — 연결이 하나라도 생겼고 아직 요약이 없으면 본문으로 만든다.
    //
    // 사양(AI_SUMMARY_SYSTEM_PROMPT)이 lot 을 참조하지 않으므로 raw 당 1회면 되고,
    // 같은 raw 가 여러 lot 에 붙으면 같은 요약을 복사한다.
    // 이 값이 없으면 주차장 종합 요약의 입력이 비어 상세 페이지에 아무것도 못 쓴다.
    let article: ArticleJudgment = {
      ...NO_JUDGMENT,
      summary: normalizeSummary(raw.ai_summary),
    }
    if (links.length > 0 && !article.summary && env?.UNSLOTH_API_KEY) {
      if (Date.now() >= aiDeadline) {
        budgetExceeded = true
      } else {
        article = await judgeArticle(
          raw,
          env.UNSLOTH_API_KEY,
          env.AI_MODEL || undefined,
          env.AI_BASE_URL || undefined,
        )
        if (article.summary) summarized++
      }
    }

    for (const { lot, score, aiResult } of links) {
      insertBatch.push(buildInsert(db, raw, lot, score, aiResult, article))
      touchedLots.add(lot.lot_id)
      lotLinks++
      thisItemLinked++
    }

    // matched_at: 매칭 시도 완료 표시 (재처리 방지)
    // 후보가 없거나 임계값 미달이어도 시도 완료로 기록.
    // 새 주차장 추가 등으로 재매칭이 필요하면 matched_at을 NULL로 리셋.
    const attempted = candidates.length > 0 || keywords.length > 0
    if (attempted) {
      if (thisItemLinked > 0) matched++

      // 후보가 아예 없으면 DB 에 없는 주차장 얘기일 수 있다 → web_sources_missed 에 남긴다 (A-5).
      // 종결 조건(raw-retention.ts)이 matched_at 을 보고 raw 를 지우므로, 여기서 안 남기면
      // 흔적 없이 사라진다. 조건·이름 추출·노이즈 규칙은 run-pipeline-149 와 같다.
      let failReason: 'lot_not_in_db' | 'noise_name' | null = null
      if (candidates.length === 0 && keywords.length > 0 && raw.full_text_status === 'ok') {
        const name = extractMissedLotName(title, content).join(' ')
        if (!name || isNoiseLotName(name)) {
          failReason = 'noise_name'
        } else {
          failReason = 'lot_not_in_db'
          // source_id 가 UNIQUE 라 재실행해도 중복이 생기지 않는다
          insertBatch.push(
            db
              .prepare(
                `INSERT OR IGNORE INTO web_sources_missed
                   (missed_lot_name, source, source_id, title, content, source_url, author,
                    published_at, raw_source_id, sentiment_score, ai_difficulty_keywords)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
              )
              .bind(
                name,
                raw.source,
                raw.source_id,
                title,
                content,
                raw.source_url,
                raw.author,
                raw.published_at,
                raw.id,
                raw.sentiment_score,
                raw.ai_difficulty_keywords,
              ),
          )
        }
      }
      updateBatch.push(
        db
          .prepare(
            "UPDATE web_sources_raw SET matched_at = datetime('now'), match_fail_reason = ?2 WHERE id = ?1",
          )
          .bind(raw.id, failReason),
      )
    }

    processedSinceFlush++
    if (processedSinceFlush >= FLUSH_EVERY) {
      await flush()
      processedSinceFlush = 0
    }
  }

  // 소비자가 평점을 다시 계산하고, 종합 요약을 다시 만들 만한 변화인지 판정해
  // 표시만 남긴다 (실제 생성은 크론 C).
  //
  // INSERT OR IGNORE 라 실제로는 중복이라 무시된 lot 이 섞일 수 있다. 그래도 보낸다 —
  // 소비자의 판정이 web_sources 실제 행 수를 세는 방식이라 헛되이 요약을 만들지 않는다.
  await flush()

  return { matched, lotLinks, aiVerified, aiRejected, rejectedBy, summarized, budgetExceeded }
}

/** 빈 문자열·공백만 있는 요약은 없는 것으로 본다 */
function normalizeSummary(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

/**
 * 글 하나에 대한 AI 판정 결과 (lot 무관).
 *
 * 요약만 쓰는 게 아니라 **품질 판정(`filter_passed_v2`)도 이 호출이 낸다.**
 * rule=high 로 들어온 행은 지금까지 어떤 AI 판정도 거치지 않아
 * `filter_passed_v2` 가 NULL 로 남았고, 스코어링(`scoring-engine.ts:64`)이
 * `= 1` 을 요구하는 탓에 **평점 집계에서 통째로 빠져 있었다**
 * (2026-09-03 실측: 최근 14일 크론 삽입 449행 전부 NULL).
 */
interface ArticleJudgment {
  summary: string | null
  /** null 이면 판정을 못 했다는 뜻 — 컬럼도 NULL 로 둔다 */
  filterPassed: boolean | null
  removedBy: string | null
  sentimentScore: number | null
  difficultyKeywords: string | null
}

const NO_JUDGMENT: ArticleJudgment = {
  summary: null,
  filterPassed: null,
  removedBy: null,
  sentimentScore: null,
  difficultyKeywords: null,
}

/**
 * 글 하나를 판정·요약한다 (lot 무관).
 *
 * 실패하면 판정 없음을 돌려주고 매칭 자체는 그대로 진행한다 —
 * 요약이 없다고 근거 링크까지 버릴 이유는 없다.
 */
async function judgeArticle(
  raw: RawRow,
  apiKey: string,
  model?: string,
  baseUrl?: string,
): Promise<ArticleJudgment> {
  const body = (raw.full_text ?? raw.content ?? '').trim()
  if (body.length < MIN_SUMMARY_LENGTH) return NO_JUDGMENT

  try {
    const text = await callAiText({
      apiKey,
      model,
      baseUrl,
      system: AI_SUMMARY_SYSTEM_PROMPT,
      // reasoning 상수항(약 500토큰) + 요약 600자
      maxTokens: 1800,
      user: `제목: ${stripHtml(raw.title)}\n\n본문:\n${body.slice(0, 6000)}`,
    })
    const parsed = parseAiJson<{
      filter_passed?: boolean
      removed_by?: string | null
      summary?: string
      sentiment_score?: number
      difficulty_keywords?: string[]
    }>(text)
    if (!parsed) return NO_JUDGMENT

    const judgment: ArticleJudgment = {
      summary: null,
      filterPassed: parsed.filter_passed === true,
      removedBy: parsed.removed_by ?? null,
      sentimentScore: typeof parsed.sentiment_score === 'number' ? parsed.sentiment_score : null,
      difficultyKeywords: Array.isArray(parsed.difficulty_keywords)
        ? JSON.stringify(parsed.difficulty_keywords)
        : null,
    }
    if (!judgment.filterPassed) return judgment

    const summary = normalizeSummary(parsed.summary)
    if (!summary || summary.length < MIN_SUMMARY_LENGTH) return judgment

    // 요약 자리에 원문 스크랩이 그대로 들어오는 사고가 반복됐다 (summary-guard 주석 참조).
    const pollution = detectSummaryPollution(summary)
    if (pollution) {
      console.log(`[match] summary rejected raw=${raw.id}: ${pollution}`)
      return judgment
    }
    return { ...judgment, summary }
  } catch (err) {
    console.log(`[match] summary error raw=${raw.id}: ${(err as Error).message}`)
    return NO_JUDGMENT
  }
}

function buildInsert(
  db: D1Database,
  raw: RawRow,
  lot: LotRow,
  score: number,
  aiResult: FilterV2Output | null,
  article: ArticleJudgment,
): D1PreparedStatement {
  const sentimentScore = aiResult?.sentiment_score ?? article.sentimentScore ?? raw.sentiment_score
  const difficultyKeywords = aiResult?.ai_difficulty_keywords
    ? JSON.stringify(aiResult.ai_difficulty_keywords)
    : (article.difficultyKeywords ?? raw.ai_difficulty_keywords)

  // 품질 판정을 컬럼에 남긴다. 판정한 적이 없으면 NULL 이다 (없는 값을 지어내지 않는다).
  //   - AI 검증을 거친 행: 통과했을 때만 여기 오므로 1
  //   - rule=high 행: 글 판정 호출(judgeArticle)의 결과를 그대로 쓴다
  // 이 값이 NULL 이면 스코어링이 그 행을 세지 않는다 (scoring-engine.ts `= 1`).
  //
  // ⚠️ `1` 의 뜻이 두 경로에서 다르다.
  //    FILTER_V2 를 거친 행의 `1` 은 **이 주차장 글이 맞다**(lot_name·lot_address 확인)는 뜻이고,
  //    rule=high 행의 `1` 은 **글이 괜찮다**는 뜻일 뿐이다 — `judgeArticle` 은 `(lot 무관)` 이라
  //    어느 주차장 글인지 보지 않는다. 그래서 `= 1` 을 "매칭 검증됨"으로 읽으면 안 된다.
  //    동명이지 오매칭은 상류에서 막는다 — `getMatchConfidence` → `scoreBlogRelevance` 의
  //    `detectRegionConflict` 가 다른 지역 글을 40점 아래로 떨어뜨려 confidence 를 'none' 으로 만든다.
  const filterPassedV2 = aiResult
    ? 1
    : article.filterPassed === null
      ? null
      : article.filterPassed
        ? 1
        : 0
  const filterV2Reason = aiResult ? null : (article.removedBy ?? null)

  // full_text는 web_sources_raw에서만 관리 (raw_source_id JOIN으로 조회).
  // web_sources는 정제된 데이터(요약/sentiment/관계)만 보유.
  return db
    .prepare(
      // matched_at은 web_sources가 자기완결적으로 갖는다 (0049) — 스코어링 재계산이
      // raw를 JOIN하지 않도록. raw는 처리 완료 후 삭제되는 임시 데이터다.
      `INSERT OR IGNORE INTO web_sources
       (parking_lot_id, source, source_id, title, content, source_url,
        author, published_at, relevance_score, raw_source_id,
        sentiment_score, ai_difficulty_keywords, ai_summary, matched_at,
        filter_passed_v2, filter_v2_reason, filter_v2_evaluated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, datetime('now'),
               ?14, ?15, CASE WHEN ?14 IS NULL THEN NULL ELSE datetime('now') END)`,
    )
    .bind(
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
      difficultyKeywords,
      // 글 요약. 이 자리는 오래 NULL 이었고(생성 단계가 파이프라인에 아예 없었다),
      // 그 결과 주차장 종합 요약의 입력이 비어 상세 페이지가 채워지지 않았다.
      article.summary,
      filterPassedV2,
      filterV2Reason,
    )
}

/** 매칭 검증 호출 — lot 정합성(wrong_lot)을 보는 판정이라 요약 사양과 프롬프트가 다르다 */
async function callPostMatchFilter(
  inputs: FilterV2Input[],
  apiKey: string,
  model?: string,
  baseUrl?: string,
): Promise<FilterV2Output[]> {
  if (inputs.length === 0) return []

  const fallback = (id: number): FilterV2Output => ({
    id,
    filter_passed: false,
    removed_by: 'ai_error',
    sentiment_score: 3.0,
    ai_difficulty_keywords: [],
  })

  // JSON 모드는 최상위가 객체여야 하므로 {"results":[...]} 로 감싸 받는다.
  const text = await callAiText({
    apiKey,
    model,
    baseUrl,
    system: FILTER_V2_SYSTEM_PROMPT,
    // reasoning 이 건수와 거의 무관한 상수항이라 넉넉히 잡는다 (부족하면 조용히 빈 응답)
    maxTokens: 1200 + 200 * inputs.length,
    user: `Process the following ${inputs.length} record(s). Respond with a JSON object of the form {"results": [...]} containing one element per record in the same order. Include the input id in each element.\n\n${buildFilterV2UserPrompt(inputs)}`,
  })

  const trimmed = text.trim()
  const wrapped = trimmed.startsWith('[') ? `{"results":${trimmed}}` : text
  const raw = parseAiJson<{ results?: FilterV2Output[] } | FilterV2Output>(wrapped)
  if (!raw) return inputs.map((input) => fallback(input.id))

  const parsed: FilterV2Output[] = Array.isArray((raw as { results?: FilterV2Output[] }).results)
    ? ((raw as { results: FilterV2Output[] }).results ?? [])
    : [raw as FilterV2Output]

  const byId = new Map(parsed.map((p) => [p.id, p]))
  return inputs.map((input, idx) => {
    const found = byId.get(input.id) ?? parsed[idx]
    return found ? { ...found, id: input.id } : fallback(input.id)
  })
}
