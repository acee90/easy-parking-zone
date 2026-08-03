/**
 * 로컬에서 만들어진 web_sources / web_sources_missed 를 remote D1에 안전 반영.
 *
 * 크롤링 워크플로우 전용 (run-pipeline 과는 별개):
 *   crawl-blogs.ts (로컬) → /run-pipeline (로컬, Stage 0~4) → **이 스크립트로 remote 반영**
 *
 * 왜 별도 스크립트인가 ([[feedback_local_crawl_raw_id_divergence]]):
 *   web_sources_raw.id 는 local/remote 가 독립 autoincrement 라 호환되지 않는다.
 *   따라서 run-pipeline Stage 5 가 emit 하는 raw by-id UPDATE(filter/matched)나
 *   raw_source_id=<local id> INSERT 를 remote 에 그대로 밀면
 *   ① FK 위반(없는 raw id) ② 엉뚱한 remote raw 행 silent 오염 이 발생한다.
 *
 *   안전한 것은 source_id 로 keyed 된 INSERT 뿐이다 (source_id 에 lot suffix 포함 → portable).
 *   이 스크립트는 web_sources / web_sources_missed 의 INSERT 만, raw_source_id=NULL 로 push 한다.
 *   raw 의 처리상태(filter_passed/matched_at/ai_filtered_at)는 remote cron 이 자체 raw 로 재유도하므로
 *   remote 에 밀지 않는다.
 *
 * 동작:
 *   1) 로컬 web_sources 에서 최근 N분 내 crawled_at 행을 읽어 INSERT OR IGNORE 생성
 *      (UNIQUE(source, source_id) 로 멱등) — raw_source_id=NULL.
 *   2) 로컬 web_sources_missed 도 동일 (unique 없음 → NOT EXISTS 가드, full_text 스테이징 컬럼 제외).
 *   3) --dry 가 아니면 remote 에 200문 단위로 적용.
 *
 * Usage:
 *   bun run scripts/sync-websources-to-remote.ts                 # 최근 180분, remote 적용
 *   bun run scripts/sync-websources-to-remote.ts --since 1440    # 최근 24시간
 *   bun run scripts/sync-websources-to-remote.ts --dry           # SQL 파일만 생성, 적용 안 함
 *   bun run scripts/sync-websources-to-remote.ts --no-missed     # web_sources 만
 *   bun run scripts/sync-websources-to-remote.ts --out /tmp/x.sql
 *
 * 주의: --remote 플래그를 주지 말 것. 읽기는 항상 로컬, 쓰기만 remote 다.
 */
import { execSync } from 'child_process'
import { writeFileSync } from 'fs'
import { d1Query } from './lib/d1'
import { sqlVal } from './lib/sql-flush'

const DB_NAME = 'parking-db'

// --- CLI ---
function argVal(flag: string): string | null {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? (process.argv[i + 1] ?? null) : null
}
const SINCE_MIN = Number(argVal('--since') ?? '180')
const DRY = process.argv.includes('--dry')
const NO_MISSED = process.argv.includes('--no-missed')
const OUT = argVal('--out') ?? '/tmp/sync-websources-remote.sql'

if (process.argv.includes('--remote')) {
  console.error('✗ --remote 금지: 읽기는 로컬, 쓰기만 remote 입니다.')
  process.exit(1)
}
if (!Number.isFinite(SINCE_MIN) || SINCE_MIN <= 0) {
  console.error(`✗ --since 값이 잘못됨: ${argVal('--since')}`)
  process.exit(1)
}

type Row = Record<string, string | number | null>

// web_sources: id 제외 전체 컬럼, raw_source_id 는 NULL 강제
const WS_SKIP = new Set(['id'])
// web_sources_missed: id/full_text 스테이징/resolution 은 제외 (lean + remote 관리 컬럼)
const MISSED_COLS = [
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
  'created_at',
]

function buildWebSources(): string[] {
  const rows = d1Query<Row>(
    `SELECT * FROM web_sources WHERE crawled_at >= datetime('now','-${SINCE_MIN} minutes')`,
  )
  if (rows.length === 0) return []
  const cols = Object.keys(rows[0]).filter((c) => !WS_SKIP.has(c))
  return rows.map((r) => {
    const vals = cols.map((c) => (c === 'raw_source_id' ? 'NULL' : sqlVal(r[c])))
    return `INSERT OR IGNORE INTO web_sources (${cols.join(', ')}) VALUES (${vals.join(', ')});`
  })
}

function buildMissed(): string[] {
  const rows = d1Query<Row>(
    `SELECT * FROM web_sources_missed WHERE created_at >= datetime('now','-${SINCE_MIN} minutes')`,
  )
  if (rows.length === 0) return []
  return rows.map((r) => {
    const vals = MISSED_COLS.map((c) => (c === 'raw_source_id' ? 'NULL' : sqlVal(r[c])))
    // unique 인덱스가 없어 INSERT OR IGNORE 가 dedup 안 됨 → (source, source_id) NOT EXISTS 가드
    const guard = `NOT EXISTS (SELECT 1 FROM web_sources_missed WHERE source = ${sqlVal(r.source)} AND source_id = ${sqlVal(r.source_id)})`
    return `INSERT INTO web_sources_missed (${MISSED_COLS.join(', ')}) SELECT ${vals.join(', ')} WHERE ${guard};`
  })
}

function applyRemote(statements: string[]): void {
  const CHUNK = 200
  for (let i = 0; i < statements.length; i += CHUNK) {
    const chunk = statements.slice(i, i + CHUNK)
    writeFileSync(OUT, chunk.join('\n'))
    execSync(`bunx wrangler d1 execute ${DB_NAME} --remote --file="${OUT}"`, { stdio: 'pipe' })
    console.log(`  적용 ${Math.min(i + CHUNK, statements.length)}/${statements.length}`)
  }
}

function main() {
  console.log(`🔄 web_sources → remote (최근 ${SINCE_MIN}분, raw_source_id=NULL)`)
  const ws = buildWebSources()
  const missed = NO_MISSED ? [] : buildMissed()
  const all = [...ws, ...missed]
  console.log(`  web_sources ${ws.length}건 + missed ${missed.length}건 = ${all.length}건`)

  if (all.length === 0) {
    console.log('  반영할 행 없음. 종료.')
    return
  }

  writeFileSync(OUT, all.join('\n') + '\n')
  console.log(`  SQL emit → ${OUT}`)

  if (DRY) {
    console.log('  --dry: remote 적용 생략.')
    return
  }
  applyRemote(all)
  console.log('✅ remote 반영 완료.')
}

main()
