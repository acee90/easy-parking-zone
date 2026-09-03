/**
 * 기존 web_sources 중 정보 모음 사이트(경쟁 애그리게이터) 행을 소급 마킹한다.
 *
 * 삭제하지 않는다 — filter_passed_v2 = 0 + filter_v2_reason 으로 표시만 한다.
 * 나중에 판정을 뒤집거나 목록을 조정할 때 되돌릴 수 있어야 하기 때문이다.
 *
 * 사용법:
 *   bun run scripts/mark-aggregator-sources.ts --remote --dry-run
 *   bun run scripts/mark-aggregator-sources.ts --remote
 */

import { unlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { AGGREGATOR_REASON, isAggregatorUrl } from '../src/server/crawlers/lib/aggregator-domains'
import { d1ExecFile, d1Query } from './lib/d1'

const DRY_RUN = process.argv.includes('--dry-run')

interface Row {
  id: number
  parking_lot_id: string
  source_url: string
  relevance_score: number
  filter_passed_v2: number | null
}

function main() {
  const rows = d1Query<Row>(
    `SELECT id, parking_lot_id, source_url, relevance_score, filter_passed_v2
       FROM web_sources WHERE source_url IS NOT NULL`,
  )

  const hits = rows.filter((r) => isAggregatorUrl(r.source_url))
  const shown = hits.filter((r) => r.relevance_score >= 40)
  const lots = new Set(hits.map((r) => r.parking_lot_id))
  const already = hits.filter((r) => r.filter_passed_v2 === 0)

  console.log(`web_sources 전체        ${rows.length.toLocaleString()}행`)
  console.log(
    `정보 모음 사이트         ${hits.length.toLocaleString()}행 (${((hits.length / rows.length) * 100).toFixed(1)}%)`,
  )
  console.log(`  └ 화면 노출 대상       ${shown.length.toLocaleString()}행`)
  console.log(`  └ 이미 마킹됨          ${already.length.toLocaleString()}행`)
  console.log(`영향 lot                ${lots.size.toLocaleString()}곳`)

  const todo = hits.filter((r) => r.filter_passed_v2 !== 0)
  if (todo.length === 0) {
    console.log('\n갱신할 행이 없습니다.')
    return
  }

  // 도메인별 내역
  const byHost = new Map<string, number>()
  for (const r of todo) {
    const h = r.source_url
      .replace(/^https?:\/\//, '')
      .split('/')[0]
      .replace(/^www\./, '')
    byHost.set(h, (byHost.get(h) ?? 0) + 1)
  }
  console.log('\n도메인별:')
  for (const [h, n] of [...byHost.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${h.padEnd(34)} ${n.toLocaleString()}행`)
  }

  if (DRY_RUN) {
    console.log(`\n[dry-run] ${todo.length.toLocaleString()}행을 마킹할 예정. 실제 변경 없음.`)
    return
  }

  const CHUNK = 500
  const file = resolve(process.cwd(), '.tmp-mark-aggregator.sql')
  let done = 0
  for (let i = 0; i < todo.length; i += CHUNK) {
    const ids = todo.slice(i, i + CHUNK).map((r) => r.id)
    const sql = `UPDATE web_sources
         SET filter_passed_v2 = 0,
             filter_v2_reason = '${AGGREGATOR_REASON}',
             filter_v2_evaluated_at = datetime('now')
       WHERE id IN (${ids.join(',')});`
    writeFileSync(file, sql)
    d1ExecFile(file)
    done += ids.length
    console.log(`  ${done.toLocaleString()} / ${todo.length.toLocaleString()}`)
  }
  try {
    unlinkSync(file)
  } catch {}
  console.log(`\n완료: ${done.toLocaleString()}행 마킹`)
}

try {
  main()
} catch (e) {
  console.error(e)
  process.exit(1)
}
