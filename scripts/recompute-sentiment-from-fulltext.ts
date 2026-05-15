/**
 * web_sources.sentiment_score 를 fulltext 기준으로 재계산.
 *
 * 절차:
 *  1. web_sources.sentiment_score 전체 NULL 초기화
 *  2. filter_passed_v2=1 AND full_text_status='ok' 대상에 대해
 *     analyzeSentiment(full_text) 결과를 SQL UPDATE로 emit
 *  3. data/sentiment-recompute.sql 저장 (--apply 옵션 시 local에 즉시 적용)
 *
 * relevance_score 는 v2 단계에서 이미 평가되었으므로 그대로 두고, sentiment_score 만 갱신.
 *
 * Usage:
 *   bun run scripts/recompute-sentiment-from-fulltext.ts             # dry-run, SQL 생성만
 *   bun run scripts/recompute-sentiment-from-fulltext.ts --apply     # local에 즉시 적용
 */

import { writeFileSync } from 'fs'
import { analyzeSentiment } from '../src/server/crawlers/lib/sentiment'
import { d1ExecFile, d1Execute, d1Query } from './lib/d1'

const APPLY = process.argv.includes('--apply')

interface Row {
  id: number
  parking_lot_id: string
  full_text: string
  full_text_length: number | null
}

console.log('[recompute-sentiment] 대상 로드 중...')
const rows = d1Query<Row>(`
  SELECT ws.id, ws.parking_lot_id, wsr.full_text AS full_text, length(wsr.full_text) AS full_text_length
  FROM web_sources ws
  JOIN web_sources_raw wsr ON wsr.id = ws.raw_source_id
  WHERE ws.filter_passed_v2 = 1
    AND ws.full_text_status = 'ok'
    AND wsr.full_text IS NOT NULL
    AND length(wsr.full_text) >= 200
`)
console.log(`[recompute-sentiment] 대상: ${rows.length}건`)

console.log('[recompute-sentiment] analyzeSentiment 실행...')
const results: { id: number; sentiment: number }[] = []
const distrib: Record<string, number> = {
  '1.0~1.5': 0,
  '1.5~2.0': 0,
  '2.0~2.5': 0,
  '2.5~3.0': 0,
  '3.0': 0,
  '3.0~3.5': 0,
  '3.5~4.0': 0,
  '4.0~4.5': 0,
  '4.5~5.0': 0,
}
let sum = 0

for (const r of rows) {
  const text = r.full_text.length > 8000 ? r.full_text.slice(0, 8000) : r.full_text
  const result = analyzeSentiment(text)
  const s = result.sentimentScore
  sum += s
  if (s < 1.5) distrib['1.0~1.5']++
  else if (s < 2.0) distrib['1.5~2.0']++
  else if (s < 2.5) distrib['2.0~2.5']++
  else if (s < 3.0) distrib['2.5~3.0']++
  else if (s === 3.0) distrib['3.0']++
  else if (s < 3.5) distrib['3.0~3.5']++
  else if (s < 4.0) distrib['3.5~4.0']++
  else if (s < 4.5) distrib['4.0~4.5']++
  else distrib['4.5~5.0']++
  results.push({ id: r.id, sentiment: s })
}

console.log(`\n[recompute-sentiment] === 새 sentiment 분포 ===`)
for (const [k, v] of Object.entries(distrib)) {
  const pct = ((v / results.length) * 100).toFixed(1)
  const bar = '█'.repeat(Math.round((v / results.length) * 50))
  console.log(`  ${k.padEnd(10)} ${String(v).padStart(6)}  ${pct.padStart(5)}%  ${bar}`)
}
console.log(`  평균: ${(sum / results.length).toFixed(3)}`)

// SQL emit: 초기화 + chunked UPDATE
const sqlLines: string[] = []
sqlLines.push(`-- 1) 전체 sentiment_score 초기화`)
sqlLines.push(`UPDATE web_sources SET sentiment_score = NULL;`)
sqlLines.push(``)
sqlLines.push(`-- 2) filter_passed_v2=1 & ft_ok 대상 재계산 (${results.length}건)`)

// CASE WHEN 기반 chunk UPDATE — chunk당 500건
const CHUNK = 500
for (let i = 0; i < results.length; i += CHUNK) {
  const chunk = results.slice(i, i + CHUNK)
  const ids = chunk.map((r) => r.id).join(',')
  const cases = chunk.map((r) => `WHEN ${r.id} THEN ${r.sentiment}`).join(' ')
  sqlLines.push(
    `UPDATE web_sources SET sentiment_score = CASE id ${cases} END WHERE id IN (${ids});`,
  )
}

const sqlPath = 'data/sentiment-recompute.sql'
writeFileSync(sqlPath, sqlLines.join('\n'), 'utf-8')
console.log(`\n[recompute-sentiment] SQL 저장: ${sqlPath} (${sqlLines.length}줄)`)

if (APPLY) {
  console.log(`\n[recompute-sentiment] --apply: local DB 적용 중...`)
  d1ExecFile(sqlPath)
  // 적용 후 검증
  const after = d1Query<{ cnt: number; avg: number | null }>(
    `SELECT COUNT(*) as cnt, AVG(sentiment_score) as avg FROM web_sources WHERE sentiment_score IS NOT NULL`,
  )[0]
  console.log(
    `[recompute-sentiment] 적용 후: ${after.cnt}건, 평균 ${after.avg?.toFixed(3) ?? 'n/a'}`,
  )
}
