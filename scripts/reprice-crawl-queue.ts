/**
 * crawl_queue.priority 를 현재 코드의 우선순위 식으로 다시 계산한다 (A-1 1회성 적용).
 *
 * 배포 후 syncQueue 가 하루 1회 같은 일을 하지만, 그때까지 기다리지 않고 즉시 반영하려고 쓴다.
 * **식은 코드에서 import 한다** — 여기 복붙하면 다음에 코드만 바뀌었을 때 조용히 어긋난다.
 *
 * 기본 동작은 SQL 파일 생성까지다 (dry-run 대신 중간저장 파일).
 * 내용을 확인한 뒤 --apply 로 wrangler --file 일괄 적용한다.
 *
 * Usage:
 *   bun run scripts/reprice-crawl-queue.ts --remote            # SQL 파일만 생성
 *   bun run scripts/reprice-crawl-queue.ts --remote --apply    # 생성 + 적용
 */

import { execSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { crawlPrioritySql } from '../src/server/crawlers/lib/crawl-queue'
import { d1Query, isRemote } from './lib/d1'

const CRAWLERS = ['naver_blogs', 'ddg', 'youtube', 'brave_search'] as const

function distribution(label: string) {
  const rows = d1Query(`
    SELECT crawler, priority, COUNT(*) AS n
      FROM crawl_queue GROUP BY crawler, priority ORDER BY crawler, priority`)
  console.log(`\n── priority 분포 (${label}) ──`)
  let current = ''
  const parts: string[] = []
  for (const r of rows) {
    if (r.crawler !== current) {
      if (parts.length) console.log(`  ${current.padEnd(13)} ${parts.join(' ')}`)
      current = String(r.crawler)
      parts.length = 0
    }
    parts.push(`p${r.priority}=${r.n}`)
  }
  if (parts.length) console.log(`  ${current.padEnd(13)} ${parts.join(' ')}`)
  return rows
}

function main() {
  if (!isRemote) {
    console.warn('⚠️  --remote 없이 실행 중입니다. 로컬 D1 에는 crawl_queue 행이 없습니다.\n')
  }

  const priority = crawlPrioritySql()
  console.log('적용할 우선순위 식 (crawl-queue.ts 에서 import):')
  console.log(priority.replace(/^/gm, '  '))

  const before = distribution('before')

  // 크롤러당 UPDATE 1건. 행 단위 wrangler 호출은 하지 않는다.
  //
  // EXISTS 가드가 필요한 이유: crawl_queue 54,130행 > parking_lots 54,072행이라
  // 삭제된 주차장을 가리키는 고아 행이 58개 있다. 가드가 없으면 스칼라 서브쿼리가
  // NULL 을 돌려주고 priority 가 NULL 이 되는데, SQLite 는 ORDER BY 에서 NULL 을
  // 맨 앞에 놓는다 — 없는 주차장이 큐 맨 앞을 차지한다.
  // (기존 syncQueue 는 `<>` 비교가 NULL 이라 우연히 고아를 건드리지 않았다.)
  const statements = CRAWLERS.map(
    (crawler) => `UPDATE crawl_queue
   SET priority = (
       SELECT ${priority}
         FROM parking_lots p
         LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
        WHERE p.id = crawl_queue.lot_id)
 WHERE crawler = '${crawler}'
   AND EXISTS (SELECT 1 FROM parking_lots p WHERE p.id = crawl_queue.lot_id)
   AND priority IS NOT (
       SELECT ${priority}
         FROM parking_lots p
         LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
        WHERE p.id = crawl_queue.lot_id);`,
  )

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)
  const dir = resolve(import.meta.dir, '../data')
  mkdirSync(dir, { recursive: true })
  const path = resolve(dir, `reprice-crawl-queue-${stamp}.sql`)
  writeFileSync(
    path,
    `-- crawl_queue priority 재계산 (A-1)\n-- 생성: ${new Date().toISOString()}\n\n${statements.join('\n\n')}\n`,
  )
  console.log(`\nSQL 생성: ${path}`)

  if (!process.argv.includes('--apply')) {
    console.log('적용하려면 --apply 를 붙여 다시 실행하세요.')
    return
  }

  console.log('\n적용 중...')
  execSync(
    `bunx wrangler d1 execute parking-db ${isRemote ? '--remote' : '--local'} --yes --file "${path}"`,
    { stdio: 'inherit' },
  )

  const after = distribution('after')
  const beforeTotal = before.reduce((a, r) => a + Number(r.n), 0)
  const afterTotal = after.reduce((a, r) => a + Number(r.n), 0)
  if (beforeTotal !== afterTotal) {
    console.error(`\n❌ 행 수가 달라졌습니다: ${beforeTotal} → ${afterTotal}`)
    process.exit(1)
  }
  console.log(`\n행 수 보존 확인: ${afterTotal}`)
}

main()
