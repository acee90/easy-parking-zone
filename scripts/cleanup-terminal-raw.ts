/**
 * 종결 상태 web_sources_raw 일괄 정리 — 백로그 전용
 *
 * 배경: 크론 6단계는 원래 본문(`web_sources_raw_body`)만 지우고 원장 행은 표시만 했다.
 *   지우는 코드가 어디에도 없어 2026-09-04 기준 152,085행 중 150,336행이 종결 상태로
 *   잔류했다. 크론에 DELETE 를 넣었지만 회당 상한(2,000)이 있어 백로그는 이 스크립트가 맡는다.
 *
 * 재크롤 안전성: 중복 판정은 `seen_sources`(0050)가 하고 크롤러 4종이 삽입 전에 조회한다.
 *   2026-09-04 실측으로 raw 전량이 seen_sources 에 있음을 확인했다(누락 0건).
 *   그래도 이 스크립트는 매 실행마다 **직접 다시 확인**하고, 누락이 있으면 중단한다 —
 *   실측은 그때의 사실이지 지금의 사실이 아니다.
 *
 * 왜 SQL 파일로 뱉는가: 15만 행을 wrangler 왕복으로 지우면 프로세스 스폰 오버헤드가
 *   작업 자체보다 크다. id 구간 DELETE 문을 chunk 파일로 emit 하고 --file 로 일괄 적용한다.
 *   (파일 확장자는 반드시 `.sql` — 아니면 D1 import API 로 넘어가 인증 에러가 난다.)
 *
 * Usage:
 *   bun run scripts/cleanup-terminal-raw.ts --remote --output-dir=data/raw-cleanup
 *   for f in data/raw-cleanup/*.sql; do bunx wrangler d1 execute parking-db --remote --file="$f"; done
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TERMINAL_RAW_CONDITION } from '../src/server/crawlers/lib/raw-retention'
import { d1Query, isRemote } from './lib/d1'

const args = process.argv.slice(2)
const OUTPUT_DIR =
  args.find((a) => a.startsWith('--output-dir='))?.split('=')[1] ?? 'data/raw-cleanup'
/** DELETE 문 하나가 훑을 id 폭. 넓히면 문장당 삭제 행이 늘어 트랜잭션이 길어진다. */
const ID_SPAN = parseInt(args.find((a) => a.startsWith('--id-span='))?.split('=')[1] ?? '20000', 10)
/** 파일당 문장 수. 5MB 넘는 SQL 파일은 D1 이 가끔 D1_RESET_DO 를 던진다. */
const STMTS_PER_FILE = parseInt(
  args.find((a) => a.startsWith('--stmts-per-file='))?.split('=')[1] ?? '200',
  10,
)

function main() {
  console.log(`대상: ${isRemote ? 'remote' : 'local'} D1`)

  // 1. 재크롤 안전성 확인. 여기서 걸리면 아무것도 지우지 않는다.
  const [missing] = d1Query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM web_sources_raw r
      LEFT JOIN seen_sources s ON s.source = r.source AND s.source_id = r.source_id
      WHERE s.source IS NULL`,
  )
  if ((missing?.n ?? -1) !== 0) {
    console.error(
      `중단: seen_sources 에 없는 raw 행이 ${missing?.n}건 있다. 지우면 그 URL 은 다시 크롤된다.`,
    )
    console.error(
      '먼저 INSERT OR IGNORE INTO seen_sources SELECT source, source_id FROM ... 로 채울 것.',
    )
    process.exit(1)
  }
  console.log('seen_sources 커버리지 확인: 누락 0건')

  // 2. 삭제 범위 파악
  const [scope] = d1Query<{ n: number; min_id: number; max_id: number }>(
    `SELECT COUNT(*) AS n, MIN(r.id) AS min_id, MAX(r.id) AS max_id
       FROM web_sources_raw r WHERE ${TERMINAL_RAW_CONDITION}`,
  )
  if (!scope || scope.n === 0) {
    console.log('종결 행 없음. 할 일 없다.')
    return
  }
  // 보존 수는 `NOT (조건)` 으로 세면 안 된다 — SQL 3값 논리 때문이다.
  // filter_passed 가 NULL 인 행(youtube_video 등)은 `filter_passed = 0` 이 NULL 이라
  // 조건 전체가 NULL 이 되고, `NOT NULL` 도 NULL 이라 WHERE 를 통과하지 못한다.
  // 그 행들은 삭제도 안 되고(WHERE 는 TRUE 만 통과) 보존 집계에도 안 잡혀 사라진 것처럼 보인다.
  // 실제로 2026-09-04 기준 1,591행이 이 상태였다. 전체에서 빼는 방식이 정확하다.
  const [total] = d1Query<{ n: number }>(`SELECT COUNT(*) AS n FROM web_sources_raw`)
  const keep = (total?.n ?? 0) - scope.n
  console.log(`삭제 대상 ${scope.n.toLocaleString()}행 (id ${scope.min_id}~${scope.max_id})`)
  console.log(`보존 ${keep.toLocaleString()}행 (전체 ${(total?.n ?? 0).toLocaleString()}행)`)

  // 3. id 구간 DELETE 문 emit
  //    본문 → 원장 순서를 구간마다 지킨다. 원장을 먼저 지우면 본문이 고아가 된다.
  mkdirSync(OUTPUT_DIR, { recursive: true })
  const stmts: string[] = []
  for (let from = scope.min_id; from <= scope.max_id; from += ID_SPAN) {
    const to = from + ID_SPAN
    const range = `r.id >= ${from} AND r.id < ${to}`
    stmts.push(
      `DELETE FROM web_sources_raw_body WHERE raw_id IN (` +
        `SELECT b.raw_id FROM web_sources_raw_body b JOIN web_sources_raw r ON r.id = b.raw_id ` +
        `WHERE ${range} AND ${TERMINAL_RAW_CONDITION});`,
    )
    stmts.push(
      `DELETE FROM web_sources_raw WHERE id IN (` +
        `SELECT r.id FROM web_sources_raw r WHERE ${range} AND ${TERMINAL_RAW_CONDITION});`,
    )
  }

  const files: string[] = []
  for (let i = 0; i < stmts.length; i += STMTS_PER_FILE) {
    const idx = String(files.length + 1).padStart(3, '0')
    const path = join(OUTPUT_DIR, `cleanup-${idx}.sql`)
    writeFileSync(path, `${stmts.slice(i, i + STMTS_PER_FILE).join('\n')}\n`)
    files.push(path)
  }

  console.log(`\n${stmts.length}개 문장 → ${files.length}개 파일`)
  console.log(
    `적용: for f in ${OUTPUT_DIR}/*.sql; do bunx wrangler d1 execute parking-db --remote --file="$f"; done`,
  )
}

main()
