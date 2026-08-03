/**
 * ai-filter 통과 raw → `web_sources_raw.search_lot_hint` 기반 강제 lot 매핑.
 * /run-pipeline Stage 4 `lot-match`를 우회한다.
 *
 * 사용 시점: `crawl-lot-keywords.ts`로 특정 lot에 강제 매핑된 raw를 크롤한 뒤,
 * lot-match가 "공영"·"용천"처럼 일반어 lot명에서 다른 lot으로 결과를 가로채는 것을
 * 막고 싶을 때. ai-filter는 lot-less라 lot-match 단계만 우회하면 충분.
 *
 * 흐름:
 *   1) `<pipeline_dir>/ai-results-*.json` 병합 → `filter_passed=true` row 수집
 *   2) 각 raw_id를 local D1에서 lookup하여 메타 + `search_lot_hint` 획득
 *   3) `--lot-id`가 주어지면 그 값으로 강제, 아니면 raw별 `search_lot_hint` 사용
 *   4) local용 / remote용 SQL 분리 emit (raw_source_id divergence 회피)
 *      - local: `web_sources.raw_source_id=raw.id` + `web_sources_raw` UPDATE 포함
 *      - remote: `web_sources.raw_source_id=NULL` (FK 위반 방지)
 *
 * Usage:
 *   bun run scripts/force-attach-by-hint.ts <pipeline_dir> <out-local.sql> <out-remote.sql>
 *   bun run scripts/force-attach-by-hint.ts <pipeline_dir> <out-local.sql> <out-remote.sql> --lot-id=KA-...
 *
 * 적용:
 *   bunx wrangler d1 execute parking-db --local  --file=<out-local.sql>
 *   bunx wrangler d1 execute parking-db --remote --file=<out-remote.sql>
 *
 * 한계:
 *   - relevance_score는 80으로 고정(강제 매핑 표시). 자동 산출 안 함.
 *   - raw UPDATE는 local 전용(remote raw.id가 달라서). remote의 raw 메타는 다음 cron이
 *     자체 처리하거나 search_lot_hint를 이용한 후속 트랙으로 동기화.
 */
import { execSync } from 'child_process'
import { readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

const DIR = process.argv[2]
const OUT_LOCAL = process.argv[3]
const OUT_REMOTE = process.argv[4]
const LOT_ID_OVERRIDE = process.argv.find((a) => a.startsWith('--lot-id='))?.split('=')[1] ?? null

if (!DIR || !OUT_LOCAL || !OUT_REMOTE) {
  console.error(
    'usage: bun scripts/force-attach-by-hint.ts <pipeline_dir> <out-local.sql> <out-remote.sql> [--lot-id=<KA-...>]',
  )
  process.exit(1)
}

// merge ai-results*.json
const files = readdirSync(DIR)
  .filter((f) => /^ai-results-\d+\.json$/.test(f))
  .sort()
const passed: Array<{
  raw_id: number
  summary?: string
  sentiment_score?: number
  ai_difficulty_keywords?: unknown
}> = []
for (const f of files) {
  const d = JSON.parse(readFileSync(join(DIR, f), 'utf-8'))
  for (const r of d.results ?? []) if (r.filter_passed) passed.push(r)
}
console.log(`passed: ${passed.length}`)
if (passed.length === 0) {
  writeFileSync(OUT_LOCAL, '')
  writeFileSync(OUT_REMOTE, '')
  process.exit(0)
}

// raw 메타 + search_lot_hint 조회 (local DB)
const ids = passed.map((r) => r.raw_id).join(',')
const cmd = `bunx wrangler d1 execute parking-db --local --json --command "SELECT id, source, source_id, source_url, title, content, author, published_at, search_lot_hint FROM web_sources_raw WHERE id IN (${ids})"`
const out = execSync(cmd, { encoding: 'utf-8', maxBuffer: 200 * 1024 * 1024 })
const rows: Record<string, string | number | null>[] = JSON.parse(out)[0]?.results ?? []
const byId = new Map(rows.map((r) => [r.id as number, r]))

const esc = (s: string) => s.replace(/'/g, "''")
const v = (x: unknown): string => {
  if (x === null || x === undefined) return 'NULL'
  if (typeof x === 'number') return String(x)
  return `'${esc(String(x))}'`
}

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
]
const localStmts: string[] = []
const remoteStmts: string[] = []
const perLot = new Map<string, number>()
let skipped = 0
for (const r of passed) {
  const raw = byId.get(r.raw_id)
  if (!raw) {
    skipped++
    continue
  }
  const lotId = LOT_ID_OVERRIDE ?? (raw.search_lot_hint as string | null)
  if (!lotId) {
    skipped++
    continue
  }
  const aiKw = r.ai_difficulty_keywords
  const aiKwStr = Array.isArray(aiKw) ? JSON.stringify(aiKw) : (aiKw as string | null)
  const baseVals = [
    v(lotId),
    v(raw.source),
    v(`${raw.source_id}:${lotId}`),
    v(raw.title),
    v(raw.content),
    v(raw.source_url),
    v(raw.author),
    v(raw.published_at),
    v(80), // 강제 매핑이라 기본값
    'PLACEHOLDER', // raw_source_id (target별로 교체)
    v(r.sentiment_score ?? null),
    aiKwStr ? v(aiKwStr as string) : 'NULL',
    v(r.summary ?? null),
    "datetime('now')",
  ]
  const localVals = [...baseVals]
  localVals[9] = v(raw.id)
  const remoteVals = [...baseVals]
  remoteVals[9] = 'NULL'
  localStmts.push(
    `INSERT OR IGNORE INTO web_sources (${cols.join(', ')}) VALUES (${localVals.join(', ')});`,
  )
  remoteStmts.push(
    `INSERT OR IGNORE INTO web_sources (${cols.join(', ')}) VALUES (${remoteVals.join(', ')});`,
  )
  // raw UPDATE (local only — remote raw_id divergence)
  localStmts.push(
    `UPDATE web_sources_raw SET ai_filtered_at=datetime('now'), matched_at=datetime('now'), filter_passed=1, ai_summary=${v(r.summary ?? null)}, sentiment_score=${v(r.sentiment_score ?? null)} WHERE id=${raw.id};`,
  )
  perLot.set(lotId, (perLot.get(lotId) ?? 0) + 1)
}
writeFileSync(OUT_LOCAL, localStmts.join('\n'))
writeFileSync(OUT_REMOTE, remoteStmts.join('\n'))
console.log(
  `local: ${localStmts.length} stmts, remote: ${remoteStmts.length} INSERTs, skipped: ${skipped}`,
)
console.log('per lot:', Object.fromEntries(perLot))
