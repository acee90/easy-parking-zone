/**
 * #148 Phase C — extract pending web_sources for filter-v2-evaluator agent.
 *
 * Computes relevance_score_v2 LOCALLY (no AI) and writes the rest as JSON
 * for the subagent to classify. The agent emits UPDATE SQL for filter_passed_v2 +
 * filter_v2_reason. relevance_score_v2 is applied separately via this script.
 *
 * Two output files:
 *   - data/filter_v2_input.json — agent input (id, lot meta, title, full_text, relevance_score_v2)
 *   - data/filter_v2_relevance.sql — pre-computed relevance UPDATEs (apply once after agent)
 *
 * Usage:
 *   bun run scripts/extract-for-filter-v2.ts --remote --source=naver_blog --limit=100
 *   bun run scripts/extract-for-filter-v2.ts --remote --source=all --limit=16500 --shards=4 --shard=0
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { scoreBlogRelevanceFull } from '../src/server/crawlers/lib/scoring'
import { d1Query, isRemote } from './lib/d1'
import { esc } from './lib/sql-flush'

type SourceType = 'naver_blog' | 'ddg_search'
const SUPPORTED: SourceType[] = ['naver_blog', 'ddg_search']

const args = process.argv.slice(2)
const SOURCE_ARG = args.find((a) => a.startsWith('--source='))?.split('=')[1] ?? 'all'
const LIMIT = parseInt(args.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? '100', 10)
const SHARDS = parseInt(args.find((a) => a.startsWith('--shards='))?.split('=')[1] ?? '1', 10)
const SHARD = parseInt(args.find((a) => a.startsWith('--shard='))?.split('=')[1] ?? '0', 10)
const FULL_TEXT_CAP = parseInt(
  args.find((a) => a.startsWith('--cap='))?.split('=')[1] ?? '6000',
  10,
)
const OUTPUT =
  args.find((a) => a.startsWith('--output='))?.split('=')[1] ?? 'data/filter_v2_input.json'

if (SHARDS < 1 || SHARD < 0 || SHARD >= SHARDS) {
  console.error(`invalid shard config`)
  process.exit(1)
}

const SOURCES_TO_PROCESS: SourceType[] =
  SOURCE_ARG === 'all' ? SUPPORTED : ([SOURCE_ARG] as SourceType[])

interface PendingRow {
  id: number
  source: string
  parking_lot_id: string
  title: string
  full_text: string
  lot_name: string
  lot_address: string
}

interface AgentInput {
  id: number
  lot_name: string
  lot_address: string
  title: string
  full_text: string
  relevance_score_v2: number
}

function fetchPending(source: SourceType, limit: number): PendingRow[] {
  const shardClause = SHARDS > 1 ? `AND ws.id % ${SHARDS} = ${SHARD}` : ''
  return d1Query<PendingRow>(`
    SELECT ws.id, ws.source, ws.parking_lot_id, ws.title, ws.full_text,
      pl.name AS lot_name, pl.address AS lot_address
    FROM web_sources ws
    JOIN parking_lots pl ON pl.id = ws.parking_lot_id
    WHERE ws.source = '${esc(source)}'
      AND ws.full_text_status = 'ok'
      AND LENGTH(ws.full_text) >= 200
      AND ws.filter_passed_v2 IS NULL
      ${shardClause}
    ORDER BY ws.id
    LIMIT ${limit}
  `)
}

function main(): void {
  console.log(`\n📤 #148 extract-for-filter-v2 — ${isRemote ? 'remote' : 'local'} D1`)
  console.log(`   source=${SOURCES_TO_PROCESS.join(',')} limit=${LIMIT}`)
  if (SHARDS > 1) console.log(`   shard=${SHARD}/${SHARDS}`)

  const all: AgentInput[] = []
  const relevanceSqls: string[] = []
  let totalPending = 0

  for (const source of SOURCES_TO_PROCESS) {
    const rows = fetchPending(source, LIMIT)
    console.log(`   ${source}: ${rows.length} rows`)
    totalPending += rows.length
    for (const r of rows) {
      const v2 = scoreBlogRelevanceFull(r.title, r.full_text, r.lot_name, r.lot_address)
      all.push({
        id: r.id,
        lot_name: r.lot_name,
        lot_address: r.lot_address,
        title: r.title.slice(0, 200),
        full_text: r.full_text.slice(0, FULL_TEXT_CAP),
        relevance_score_v2: v2,
      })
      relevanceSqls.push(`UPDATE web_sources SET relevance_score_v2 = ${v2} WHERE id = ${r.id};`)
    }
  }

  // Output paths
  const jsonPath = resolve(import.meta.dir, '..', OUTPUT)
  const sqlPath = jsonPath.replace(/\.json$/, '_relevance.sql')
  mkdirSync(resolve(jsonPath, '..'), { recursive: true })
  writeFileSync(jsonPath, JSON.stringify(all, null, 2), 'utf-8')
  writeFileSync(sqlPath, relevanceSqls.join('\n') + '\n', 'utf-8')

  // Stats summary
  const v2Stats = all.map((a) => a.relevance_score_v2)
  const avg =
    v2Stats.length > 0 ? Math.round(v2Stats.reduce((a, b) => a + b, 0) / v2Stats.length) : 0
  const above40 = v2Stats.filter((s) => s >= 40).length
  const above60 = v2Stats.filter((s) => s >= 60).length

  console.log(`\n✅ wrote ${jsonPath} (${all.length} records)`)
  console.log(`✅ wrote ${sqlPath} (${relevanceSqls.length} UPDATEs)`)
  console.log(
    `   relevance_v2 avg: ${avg}, ≥40: ${above40} (${((above40 / all.length) * 100).toFixed(1)}%), ≥60: ${above60} (${((above60 / all.length) * 100).toFixed(1)}%)`,
  )
  console.log(`\n다음 단계:`)
  console.log(`   1. relevance UPDATE 적용:`)
  console.log(`      bunx wrangler d1 execute parking-db --remote --file=${sqlPath}`)
  console.log(`   2. filter-v2-evaluator 에이전트 호출 (Task 도구)`)
  console.log(`      입력: ${jsonPath}`)
  console.log(`   3. agent 출력 SQL 적용:`)
  console.log(
    `      bunx wrangler d1 execute parking-db --remote --file=${jsonPath.replace('.json', '.sql')}`,
  )
}

main()
