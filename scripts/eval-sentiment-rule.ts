/**
 * 답지(round-N-output.json) vs 현재 sentiment.ts 룰 단독 평가.
 *
 * 절차:
 *   1. 답지 모두 로드 (round-*-output.json 병합)
 *   2. 각 ID의 web_sources_raw.full_text 로드
 *   3. analyzeSentiment(text) 룰 단독 점수 계산
 *   4. gold vs rule MAE, bucket별 정확도, category별 분포 출력
 *
 * Usage:
 *   bun run scripts/eval-sentiment-rule.ts
 */

import { existsSync, readdirSync, readFileSync } from 'fs'
import { analyzeSentiment } from '../src/server/crawlers/lib/sentiment'
import { d1Query } from './lib/d1'

interface Gold {
  id: number
  gold_score: number
  current_score: number
  diff: number
  category: string
  reason: string
}

const dir = 'data/sentiment-eval/sonnet'
const golds: Gold[] = []
for (const f of readdirSync(dir)
  .filter((x) => x.endsWith('-output.json'))
  .sort()) {
  if (!existsSync(`${dir}/${f}`)) continue
  const data = JSON.parse(readFileSync(`${dir}/${f}`, 'utf-8')) as Gold[]
  golds.push(...data)
}
console.log(`답지 로드: ${golds.length}건`)

// full_text 로드
const ids = golds.map((g) => g.id).join(',')
const rows = d1Query<{ id: number; full_text: string }>(`
  SELECT ws.id, wsr.full_text
  FROM web_sources ws
  JOIN web_sources_raw wsr ON wsr.id = ws.raw_source_id
  WHERE ws.id IN (${ids})
`)
const textById = new Map(rows.map((r) => [r.id, r.full_text]))

// 평가
interface Eval {
  id: number
  gold: number
  rule: number
  diff: number
  category: string
  bucket: string
}
const evals: Eval[] = []
for (const g of golds) {
  const text = textById.get(g.id) ?? ''
  const sliced = text.length > 8000 ? text.slice(0, 8000) : text
  const result = analyzeSentiment(sliced)
  const rule = result.sentimentScore
  const bucket = (Math.floor(g.gold_score * 2) / 2).toFixed(1)
  evals.push({
    id: g.id,
    gold: g.gold_score,
    rule,
    diff: rule - g.gold_score,
    category: g.category,
    bucket,
  })
}

// 통계
const mae = evals.reduce((s, e) => s + Math.abs(e.diff), 0) / evals.length
const rmse = Math.sqrt(evals.reduce((s, e) => s + e.diff ** 2, 0) / evals.length)
const biasMean = evals.reduce((s, e) => s + e.diff, 0) / evals.length
console.log(`\n=== 전체 ===`)
console.log(
  `MAE = ${mae.toFixed(3)}  RMSE = ${rmse.toFixed(3)}  Bias(mean diff) = ${biasMean.toFixed(3)}`,
)

console.log(`\n=== Gold bucket별 ===`)
const buckets: Record<string, Eval[]> = {}
for (const e of evals) {
  buckets[e.bucket] ??= []
  buckets[e.bucket].push(e)
}
for (const b of Object.keys(buckets).sort()) {
  const es = buckets[b]
  const ruleAvg = es.reduce((s, e) => s + e.rule, 0) / es.length
  const mae = es.reduce((s, e) => s + Math.abs(e.diff), 0) / es.length
  console.log(
    `  ${b}  n=${String(es.length).padStart(3)}  rule_avg=${ruleAvg.toFixed(2)}  MAE=${mae.toFixed(2)}`,
  )
}

console.log(`\n=== Category별 ===`)
const cats: Record<string, Eval[]> = {}
for (const e of evals) {
  cats[e.category] ??= []
  cats[e.category].push(e)
}
for (const c of Object.keys(cats).sort()) {
  const es = cats[c]
  const goldAvg = es.reduce((s, e) => s + e.gold, 0) / es.length
  const ruleAvg = es.reduce((s, e) => s + e.rule, 0) / es.length
  const mae = es.reduce((s, e) => s + Math.abs(e.diff), 0) / es.length
  console.log(
    `  ${c.padEnd(18)}  n=${String(es.length).padStart(3)}  gold_avg=${goldAvg.toFixed(2)}  rule_avg=${ruleAvg.toFixed(2)}  MAE=${mae.toFixed(2)}`,
  )
}

console.log(`\n=== Worst 10 (|diff| 큰 순) ===`)
const worst = [...evals].sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff)).slice(0, 10)
for (const e of worst) {
  console.log(
    `  id=${e.id} gold=${e.gold} rule=${e.rule.toFixed(2)} diff=${e.diff.toFixed(2)} [${e.category}]`,
  )
}
