#!/usr/bin/env bun
/**
 * Phase 2 후처리 안전망: parking_lot_stats.ai_summary 가 짧은 lot 의 summary 를 NULL 로 만든다.
 *
 * 동기: agent 가 "5분당 150원 요금입니다" 같은 단편 fact 1개로 summary 를 작성하는 케이스가 있다.
 *      이런 summary 는 ai_tip_pricing 과 중복이거나 lot 전체 인상을 전혀 전달하지 못한다.
 *      agent 정의에 50자 미만 NULL 규칙이 명시되어 있으나, 안전망으로 후처리에서도 한 번 더 정리한다.
 *
 * 동작:
 *   1. data/lots_for_summary.json 에서 lot id 목록 추출 (방금 Phase 2 처리한 lot 만 대상)
 *   2. local DB 에서 해당 lot 중 length(ai_summary) < threshold 인 row 식별
 *   3. data/clear-short-lots.sql 생성: 각 lot 의 ai_summary 를 NULL 로 만드는 UPDATE
 *   4. --apply 면 local DB 에 즉시 적용 (remote 는 별도)
 *
 * Usage:
 *   bun run scripts/clear-short-lot-summaries.ts                       # dry-run, threshold 50
 *   bun run scripts/clear-short-lot-summaries.ts --threshold 80        # dry-run, threshold 80
 *   bun run scripts/clear-short-lot-summaries.ts --threshold 50 --apply # 적용
 *   bun run scripts/clear-short-lot-summaries.ts --input data/...json  # 다른 입력
 */
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

interface LotRecord {
  id: string
}

interface DbRow {
  parking_lot_id: string
  len: number | null
  s: string | null
}

const args = process.argv.slice(2)
const apply = args.includes('--apply')

const thresholdIdx = args.indexOf('--threshold')
const threshold = thresholdIdx >= 0 ? Number(args[thresholdIdx + 1]) : 50

const inputIdx = args.indexOf('--input')
const inputPath = inputIdx >= 0 ? args[inputIdx + 1] : 'data/lots_for_summary.json'

const outputIdx = args.indexOf('--output')
const outputPath = outputIdx >= 0 ? args[outputIdx + 1] : 'data/clear-short-lots.sql'

console.log(`\n🧹 짧은 lot summary NULL 정화 (threshold ${threshold}자)`)
console.log(`  입력: ${inputPath}`)
console.log(`  출력: ${outputPath}`)
console.log(`  ${apply ? 'APPLY mode (local DB 적용)' : 'DRY-RUN (DB 변경 없음)'}`)

const fullInput = resolve(import.meta.dir, '..', inputPath)
if (!existsSync(fullInput)) {
  console.error(`\n❌ 입력 파일 없음: ${fullInput}`)
  process.exit(1)
}

const lots: LotRecord[] = JSON.parse(readFileSync(fullInput, 'utf-8'))
console.log(`\n  1. 대상 lot: ${lots.length}건`)

if (lots.length === 0) {
  console.log('  ⚠️  대상 없음. 종료.')
  process.exit(0)
}

const idList = lots.map((l) => `'${l.id.replace(/'/g, "''")}'`).join(',')
const sql = `SELECT parking_lot_id, length(ai_summary) AS len, SUBSTR(ai_summary, 1, 100) AS s FROM parking_lot_stats WHERE parking_lot_id IN (${idList}) AND ai_summary IS NOT NULL AND length(ai_summary) < ${threshold};`

console.log(`\n  2. local DB 조회 중...`)
let rows: DbRow[] = []
try {
  const out = execSync(
    `bunx wrangler d1 execute parking-db --local --command "${sql.replace(/"/g, '\\"')}" --json`,
    { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 },
  )
  const parsed = JSON.parse(out)
  rows = parsed[0]?.results ?? []
} catch (err: unknown) {
  console.error(`\n❌ DB 조회 실패: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}

console.log(`     조회: ${rows.length}건 (length < ${threshold})`)

if (rows.length === 0) {
  console.log('\n  ✅ 짧은 summary 없음. 종료.')
  process.exit(0)
}

console.log(`\n  3. 샘플 5건:`)
for (const r of rows.slice(0, 5)) {
  console.log(`     ${r.parking_lot_id} (${r.len}자): "${r.s}"`)
}

const sqlOut = rows
  .map(
    (r) =>
      `UPDATE parking_lot_stats SET ai_summary = NULL WHERE parking_lot_id = '${r.parking_lot_id.replace(/'/g, "''")}';`,
  )
  .join('\n')

const fullOutput = resolve(import.meta.dir, '..', outputPath)
writeFileSync(fullOutput, sqlOut + '\n', 'utf-8')
console.log(`\n  4. SQL 저장: ${fullOutput} (${rows.length}건)`)

if (apply) {
  console.log(`\n  5. local DB 적용 중...`)
  execSync(`bunx wrangler d1 execute parking-db --local --file "${fullOutput}"`, {
    stdio: 'inherit',
  })
  console.log(`\n  ✅ 완료. remote 적용은 별도로:`)
  console.log(`     bunx wrangler d1 execute parking-db --remote --file ${outputPath}`)
} else {
  console.log(`\n  ℹ️  --apply 플래그 없음. DB 변경 없이 종료.`)
  console.log(
    `     실제 적용: bun run scripts/clear-short-lot-summaries.ts --threshold ${threshold} --apply`,
  )
}
