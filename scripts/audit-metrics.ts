/**
 * site-audit-2026-09-10.md 의 A 작업 평가항목을 한 번에 측정한다.
 *
 * 각 작업 반영 **전/후**로 실행해 `data/audit-metrics-YYYYMMDD-HHMM.json` 에 남기고,
 * 계획 문서의 「결과」 칸을 이 값으로 채운다.
 *
 * Usage:
 *   bun run scripts/audit-metrics.ts --remote
 *   bun run scripts/audit-metrics.ts --remote --json-only   # 콘솔 표 없이 파일만
 */

import { mkdirSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { d1Query, isRemote } from './lib/d1'

/** 크롤 대상 선정과 **같은** 정렬. selectFromQueue 가 바뀌면 여기도 바꾼다. */
const SELECT_ORDER = 'ORDER BY q.priority, q.next_at'

/** 테이블이 아직 없을 수 있는 지표는 실패를 값 대신 null 로 돌려준다. */
function safe<T>(fn: () => T): T | null {
  try {
    return fn()
  } catch (err) {
    console.warn(`  (건너뜀: ${(err as Error).message.split('\n')[0].slice(0, 120)})`)
    return null
  }
}

function num(rows: Record<string, unknown>[], key: string): number {
  return Number(rows[0]?.[key] ?? 0)
}

function collect() {
  const out: Record<string, unknown> = {
    measuredAt: new Date().toISOString(),
    target: isRemote ? 'remote' : 'local',
  }

  // ── A-1: 크롤 큐 우선순위 / 재크롤 정책 ──
  console.log('\n[A-1] crawl_queue')

  const queue = d1Query(`
    SELECT crawler,
           COUNT(*) AS total,
           SUM(next_at <= datetime('now')) AS due,
           SUM(next_at = '2000-01-01 00:00:00') AS never_crawled,
           SUM(priority = 0) AS p0,
           SUM(priority = 4) AS p4
      FROM crawl_queue
     GROUP BY crawler
     ORDER BY crawler`)
  out.crawlQueue = queue
  for (const r of queue) {
    console.log(
      `  ${String(r.crawler).padEnd(13)} total=${r.total} due=${r.due} never=${r.never_crawled} p0=${r.p0} p4=${r.p4}`,
    )
  }

  const prio = d1Query(`
    SELECT priority, COUNT(*) AS n, SUM(next_at <= datetime('now')) AS due
      FROM crawl_queue WHERE crawler = 'naver_blogs'
     GROUP BY priority ORDER BY priority`)
  out.naverPriorityDist = prio
  console.log(`  naver priority 분포: ${prio.map((r) => `p${r.priority}=${r.n}`).join(' ')}`)

  // 평가항목 A-1 #3 — 다음 600곳(하루치) 중 web_sources 0건 비율.
  // selectFromQueue 와 같은 WHERE/ORDER BY 를 써야 의미가 있다.
  const head = d1Query(`
    SELECT SUM(w.parking_lot_id IS NULL) AS zero_src, COUNT(*) AS n
      FROM (SELECT q.lot_id
              FROM crawl_queue q
             WHERE q.crawler = 'naver_blogs' AND q.next_at <= datetime('now')
             ${SELECT_ORDER}
             LIMIT 600) sel
      LEFT JOIN (SELECT DISTINCT parking_lot_id FROM web_sources) w
             ON w.parking_lot_id = sel.lot_id`)
  const zeroSrc = num(head, 'zero_src')
  const headN = num(head, 'n')
  out.nextDayZeroSourceRatio = headN > 0 ? zeroSrc / headN : null
  console.log(
    `  다음 600곳 중 web_sources 0건: ${zeroSrc}/${headN} (${headN ? ((zeroSrc / headN) * 100).toFixed(1) : '—'}%)`,
  )

  // ── 커버리지 ──
  console.log('\n[커버리지]')
  const cov = d1Query(`
    SELECT (SELECT COUNT(*) FROM parking_lots) AS lots,
           (SELECT COUNT(DISTINCT parking_lot_id) FROM web_sources) AS lots_with_web,
           (SELECT COUNT(*) FROM parking_lot_stats) AS stats_rows,
           (SELECT COUNT(*) FROM parking_lot_stats WHERE review_count > 0) AS lots_with_review`)
  out.coverage = cov[0]
  const lots = num(cov, 'lots')
  const withWeb = num(cov, 'lots_with_web')
  out.zeroWebSourceLots = lots - withWeb
  console.log(`  주차장 ${lots} / web_sources 있음 ${withWeb} / 0건 ${lots - withWeb}`)
  console.log(`  stats 행 ${num(cov, 'stats_rows')} / 리뷰 있음 ${num(cov, 'lots_with_review')}`)

  // ── A-6: 유기 리뷰 추세 (시드·커뮤니티 이관분 제외) ──
  console.log('\n[A-6] 유기 리뷰 월별')
  const reviews = d1Query(`
    SELECT strftime('%Y-%m', created_at) AS ym, COUNT(*) AS n
      FROM user_reviews
     WHERE is_seed = 0 AND source_type IS NULL
     GROUP BY ym ORDER BY ym`)
  out.organicReviewsByMonth = reviews
  console.log(`  ${reviews.map((r) => `${r.ym}:${r.n}`).join(' ')}`)

  // ── A-3: raw 에 남아 있는 유튜브 URL ──
  console.log('\n[A-3] youtube')
  const yt = safe(() =>
    d1Query(
      `SELECT COUNT(*) AS raw_youtube_urls FROM web_sources_raw
        WHERE source_url LIKE '%youtube.com/watch%' OR source_url LIKE '%youtu.be/%'`,
    ),
  )
  if (yt) {
    out.rawYoutubeUrls = num(yt, 'raw_youtube_urls')
    console.log(`  raw 유튜브 URL ${num(yt, 'raw_youtube_urls')}건`)
  }
  const media = safe(() => d1Query(`SELECT COUNT(*) AS n FROM parking_media`))
  if (media) {
    out.parkingMedia = num(media, 'n')
    console.log(`  parking_media ${num(media, 'n')}건`)
  }

  // ── A-5: ghost POI 후보 (테이블은 A-5 에서 생긴다) ──
  console.log('\n[A-5] ghost POI')
  const ghost = safe(() =>
    d1Query(`SELECT COUNT(*) AS n, SUM(seen_count >= 2) AS repeated FROM ghost_poi_candidates`),
  )
  if (ghost) {
    out.ghostPoiCandidates = ghost[0]
    console.log(`  후보 ${num(ghost, 'n')}건 (2회 이상 ${num(ghost, 'repeated')}건)`)
  } else {
    out.ghostPoiCandidates = null
  }

  return out
}

function main() {
  if (!isRemote) {
    console.warn('⚠️  --remote 없이 실행 중입니다. 로컬 D1 은 행이 비어 있어 의미가 없습니다.\n')
  }

  const metrics = collect()

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)
  const dir = resolve(import.meta.dir, '../data')
  mkdirSync(dir, { recursive: true })
  const path = resolve(dir, `audit-metrics-${stamp}.json`)
  writeFileSync(path, JSON.stringify(metrics, null, 2))
  console.log(`\n저장: ${path}`)
}

main()
