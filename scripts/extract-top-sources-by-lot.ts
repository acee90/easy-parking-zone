/**
 * lot당 top-N web_sources 후보군 추출 스크립트
 *
 * 이슈 #135: long-form ai_summary 재생성을 위한 후보군 선별.
 * lot별로 quality_score 계산 → 그리디 source 다양성 보장 → top-N 선택.
 * user_reviews JOIN으로 review_comments 채움.
 *
 * Usage:
 *   bun run scripts/extract-top-sources-by-lot.ts                          # 로컬 DB, 모든 lot
 *   bun run scripts/extract-top-sources-by-lot.ts --remote --limit-lots 10
 *   bun run scripts/extract-top-sources-by-lot.ts --remote --top-n 5 --min-content 200
 *   bun run scripts/extract-top-sources-by-lot.ts --remote --lot-id KA-1935812519
 *
 * 출력: data/top-sources-by-lot.json (또는 --output 경로)
 */
import { mkdirSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { d1Query, isRemote } from './lib/d1'

// ── CLI 옵션 ──
const args = process.argv.slice(2)

function getArg(name: string, defaultValue: string): string {
  const idx = args.indexOf(name)
  return idx >= 0 ? args[idx + 1] : defaultValue
}

function getNumArg(name: string, defaultValue: number): number {
  const v = getArg(name, '')
  return v ? parseInt(v, 10) : defaultValue
}

const TOP_N = getNumArg('--top-n', 5)
const LIMIT_LOTS = getNumArg('--limit-lots', 0) // 0 = no limit
const MIN_CONTENT = getNumArg('--min-content', 200)
const MAX_MATCHED_LOTS = getNumArg('--max-matched-lots', 3) // 1 source가 N개 초과 lot에 매칭되면 나열글로 간주, skip
const LOT_ID = getArg('--lot-id', '')
const OUTPUT = getArg('--output', 'data/top-sources-by-lot.json')
// source 화이트리스트 (콤마 구분). 기본: #149 파이프라인이 산출하는 실제 source 셋과 일치.
// ddg_search/naver_blog/naver_cafe는 snippet only이거나 매체/보도자료 비율 높아 기본 제외.
// 전체 허용하려면 --source-whitelist all
const SOURCE_WHITELIST = getArg('--source-whitelist', 'naver_blog,naver_cafe,ddg_search')

// ── Types ──
interface SourceRow {
  id: number
  parking_lot_id: string
  parking_lot_name: string
  source: string
  title: string
  content: string
  full_text: string | null
  source_url: string
  relevance_score: number
  sentiment_score: number | null
  ai_difficulty_keywords: string | null
  ai_summary: string | null
  ai_summary_updated_at: string | null
  matched_lot_count: number
  content_len: number
}

interface ReviewRow {
  parking_lot_id: string
  comment: string
}

interface OutputRecord {
  id: number
  parking_lot_id: string
  parking_lot_name: string
  title: string
  content: string
  review_comments: string
  quality_score: number
  source: string
  current_summary_len: number
}

// ── quality_score 계산 ──
function computeQualityScore(row: SourceRow): number {
  // full_text가 있으면 그 길이로, 없으면 content 길이로 (최대 2000자 기준 정규화)
  const textLen = row.full_text ? row.full_text.length : row.content_len
  const contentNorm = Math.min(textLen / 2000, 1.0)
  const relevanceNorm = Math.min(row.relevance_score / 100, 1.0)

  const fulltextSources = new Set(['naver_blog', 'naver_cafe', 'tistory_blog', 'youtube_comment'])
  const sourceNorm = fulltextSources.has(row.source) ? 1.0 : 0.3

  let keywordCount = 0
  if (row.ai_difficulty_keywords) {
    try {
      const arr = JSON.parse(row.ai_difficulty_keywords)
      if (Array.isArray(arr)) keywordCount = arr.length
    } catch {
      keywordCount = 0
    }
  }
  const keywordNorm = Math.min(keywordCount / 5, 1.0)

  const sentiment = row.sentiment_score ?? 3.0
  const sentimentNorm = Math.min(Math.abs(sentiment - 3.0) / 2.0, 1.0)

  // matched_lot_count: 1 source가 N lot에 매칭은 정상 (예: "이천 1~4공영" 한 글에 4 lot).
  // lot-specific 추출은 agent가 담당하므로 소량 매칭(≤5)은 무벌점.
  // 6+는 "남해 38곳" 같은 광범위 나열글 → lot-specific 추출이 실질 어려움 → 약한 페널티.
  const dupPenalty =
    row.matched_lot_count <= 5 ? 0 : Math.min((row.matched_lot_count - 5) * 0.03, 0.2)

  const score =
    contentNorm * 0.3 +
    relevanceNorm * 0.3 +
    sourceNorm * 0.1 +
    keywordNorm * 0.1 +
    sentimentNorm * 0.05 -
    dupPenalty

  return Math.max(0, Math.round(score * 1000) / 1000)
}

// ── 그리디 source 다양성 선택 ──
function pickTopNWithDiversity(candidates: SourceRow[], n: number): SourceRow[] {
  if (candidates.length <= n) return candidates

  // quality_score 내림차순 정렬
  const sorted = [...candidates].sort((a, b) => computeQualityScore(b) - computeQualityScore(a))

  const selected: SourceRow[] = []
  const usedSources = new Set<string>()
  const halfN = Math.ceil(n / 2)

  // 1단계: 절반까지는 source 다양성 강제
  for (const c of sorted) {
    if (selected.length >= halfN) break
    if (usedSources.has(c.source)) continue
    selected.push(c)
    usedSources.add(c.source)
  }

  // 2단계: 나머지는 점수 순으로 채움 (이미 선택된 row 제외)
  const selectedIds = new Set(selected.map((s) => s.id))
  for (const c of sorted) {
    if (selected.length >= n) break
    if (selectedIds.has(c.id)) continue
    selected.push(c)
    selectedIds.add(c.id)
  }

  return selected
}

// ── DB 쿼리 ──
function selectAllSources(): SourceRow[] {
  const lotFilter = LOT_ID ? `AND ws.parking_lot_id = '${LOT_ID}'` : ''
  const sourceFilter =
    SOURCE_WHITELIST === 'all'
      ? ''
      : `AND ws.source IN (${SOURCE_WHITELIST.split(',')
          .map((s) => `'${s.trim()}'`)
          .join(',')})`

  // matched_lot_count: 같은 source_url이 매칭된 distinct lot 수
  // 같은 source가 N개 lot에 정보를 갖는 건 정상 패턴 — penalty 아닌 lot-specific 추출 필요 신호
  // full_text는 web_sources_raw에서 raw_source_id로 JOIN하여 조회.
  const sql = `
    SELECT
      ws.id,
      ws.parking_lot_id,
      pl.name as parking_lot_name,
      ws.source,
      ws.title,
      ws.content,
      wsr.full_text,
      ws.source_url,
      ws.relevance_score,
      ws.sentiment_score,
      ws.ai_difficulty_keywords,
      ws.ai_summary,
      ws.ai_summary_updated_at,
      LENGTH(ws.content) as content_len,
      (
        SELECT COUNT(DISTINCT ws2.parking_lot_id)
        FROM web_sources ws2
        WHERE ws2.source_url = ws.source_url
      ) as matched_lot_count
    FROM web_sources ws
    INNER JOIN parking_lots pl ON ws.parking_lot_id = pl.id
    LEFT JOIN web_sources_raw wsr ON wsr.id = ws.raw_source_id
    WHERE wsr.full_text IS NOT NULL AND wsr.full_text != ''
      AND ws.ai_summary IS NULL
    ${sourceFilter}
    ${lotFilter}
    ORDER BY ws.parking_lot_id, ws.relevance_score DESC
  `
  return d1Query<SourceRow>(sql)
}

function selectAllReviews(): ReviewRow[] {
  const sql = LOT_ID
    ? `SELECT parking_lot_id, comment FROM user_reviews WHERE parking_lot_id = '${LOT_ID}' AND comment IS NOT NULL AND comment != ''`
    : `SELECT parking_lot_id, comment FROM user_reviews WHERE comment IS NOT NULL AND comment != ''`
  return d1Query<ReviewRow>(sql)
}

// ── Main ──
function main() {
  console.log(`\n🎯 후보군 추출 — ${isRemote ? 'remote' : 'local'} DB`)
  console.log(
    `  파라미터: top-n=${TOP_N}, min-content=${MIN_CONTENT}, limit-lots=${LIMIT_LOTS || 'all'}${LOT_ID ? `, lot-id=${LOT_ID}` : ''}`,
  )

  console.log(`\n  1. web_sources 조회 중...`)
  const rawSources = selectAllSources()
  const sources = rawSources.filter((r) => r.matched_lot_count <= MAX_MATCHED_LOTS)
  console.log(
    `     로드: ${rawSources.length}건 → 다중 lot 나열글 제외 후: ${sources.length}건 (max-matched-lots=${MAX_MATCHED_LOTS})`,
  )

  if (sources.length === 0) {
    console.log('\n  ⚠️  대상 row 없음.')
    return
  }

  console.log(`\n  2. user_reviews 조회 중...`)
  const reviews = selectAllReviews()
  const reviewMap = new Map<string, string[]>()
  for (const r of reviews) {
    if (!reviewMap.has(r.parking_lot_id)) reviewMap.set(r.parking_lot_id, [])
    reviewMap.get(r.parking_lot_id)!.push(r.comment)
  }
  console.log(`     로드: ${reviews.length}건 (lot ${reviewMap.size}개)`)

  // lot별 그룹화
  const byLot = new Map<string, SourceRow[]>()
  for (const s of sources) {
    if (!byLot.has(s.parking_lot_id)) byLot.set(s.parking_lot_id, [])
    byLot.get(s.parking_lot_id)!.push(s)
  }
  console.log(`\n  3. lot 그룹: ${byLot.size}개`)

  // lot의 web_sources 풍부도 순으로 정렬 (--limit-lots 적용 시 풍부한 lot 우선)
  const sortedLots = [...byLot.entries()].sort((a, b) => b[1].length - a[1].length)
  const targetLots = LIMIT_LOTS > 0 ? sortedLots.slice(0, LIMIT_LOTS) : sortedLots

  console.log(`\n  4. top-${TOP_N} 그리디 선택 중... (대상 lot: ${targetLots.length}개)`)

  const output: OutputRecord[] = []
  let totalCandidates = 0
  const sourceDist = new Map<string, number>()

  for (const [lotId, candidates] of targetLots) {
    totalCandidates += candidates.length
    const top = pickTopNWithDiversity(candidates, TOP_N)
    const reviewComments = (reviewMap.get(lotId) ?? []).join(' | ')

    for (const c of top) {
      sourceDist.set(c.source, (sourceDist.get(c.source) ?? 0) + 1)
      output.push({
        id: c.id,
        parking_lot_id: c.parking_lot_id,
        parking_lot_name: c.parking_lot_name,
        title: c.title,
        content: c.full_text ?? c.content,
        review_comments: reviewComments,
        quality_score: computeQualityScore(c),
        source: c.source,
        current_summary_len: c.ai_summary?.length ?? 0,
      })
    }
  }

  console.log(`\n  5. 결과`)
  console.log(`     처리 lot: ${targetLots.length}`)
  console.log(
    `     후보 row: ${totalCandidates}건 (lot당 평균 ${(totalCandidates / targetLots.length).toFixed(1)}건)`,
  )
  console.log(
    `     선택 row: ${output.length}건 (lot당 평균 ${(output.length / targetLots.length).toFixed(1)}건)`,
  )
  console.log(`     source 분포:`)
  for (const [src, cnt] of [...sourceDist.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`       ${src.padEnd(18)} ${cnt}`)
  }

  const lenDist = output.reduce(
    (acc, r) => {
      if (r.current_summary_len === 0) acc.empty++
      else if (r.current_summary_len < 200) acc.short++
      else acc.ok++
      return acc
    },
    { empty: 0, short: 0, ok: 0 },
  )
  console.log(`\n     기존 ai_summary 길이 분포 (선택된 row 기준):`)
  console.log(`       빈 문자열/NULL: ${lenDist.empty}건`)
  console.log(`       200자 미만:    ${lenDist.short}건`)
  console.log(`       200자 이상:    ${lenDist.ok}건 (long-form 갱신 가치 낮음)`)

  // 출력
  const outputPath = resolve(import.meta.dir, '..', OUTPUT)
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf-8')
  console.log(`\n  ✅ 저장: ${outputPath}\n`)
}

main()
