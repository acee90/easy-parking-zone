/**
 * resolved_existing_lot missed → web_sources 재연결
 *
 * 계획: docs/exec-plans/missed-web-sources-new-parking-lots.plan.md (Stage C-3, 타입1)
 *
 * resolution_status='resolved_existing_lot' 인 missed 행(이름매칭은 실패했으나 좌표상
 * 기존 lot)을 실제 web_sources에 연결한다. web_sources는 사용자 노출 콘텐츠이므로
 * 관련성 게이트(scoreBlogRelevance >= MIN_SCORE)를 통과한 행만 링크해 우연 매칭
 * (예: "서울"→롯데월드) 오링크를 차단. buildInsertSql과 동일 컬럼 형식.
 *
 * ai_summary는 missed에 없으므로 NULL → 후속 regen 대상.
 *
 * Usage:
 *   bun run scripts/relink-existing-missed.ts                 # dry-run (score 분포 + pass/skip)
 *   bun run scripts/relink-existing-missed.ts --apply         # SQL 생성 + 로컬 적용
 *   bun run scripts/relink-existing-missed.ts --min-score 50
 *
 * 로컬 D1. remote 반영: 생성된 SQL 파일을 wrangler --remote --file 로 적용.
 */
import { mkdirSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { scoreBlogRelevance, stripHtml } from '../src/server/crawlers/lib/scoring'
import { d1ExecFile, d1Query } from './lib/d1'
import { sqlVal } from './lib/sql-flush'

const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const msIdx = args.indexOf('--min-score')
const MIN_SCORE = msIdx >= 0 ? parseInt(args[msIdx + 1], 10) : 40
const todayTag = new Date().toISOString().slice(0, 10).replace(/-/g, '')
const OUT_SQL = `data/relink-existing-${todayTag}.sql`

interface Row {
  id: number
  source: string
  source_id: string
  title: string
  content: string
  source_url: string
  author: string | null
  published_at: string | null
  raw_source_id: number | null
  sentiment_score: number | null
  ai_difficulty_keywords: string | null
  resolved_parking_lot_id: string
  lot_name: string
  lot_address: string
}

function loadRows(): Row[] {
  return d1Query<Row>(`
    SELECT m.id, m.source, m.source_id, m.title, m.content, m.source_url,
           m.author, m.published_at, m.raw_source_id, m.sentiment_score,
           m.ai_difficulty_keywords, m.resolved_parking_lot_id,
           p.name AS lot_name, p.address AS lot_address
    FROM web_sources_missed m
    JOIN parking_lots p ON p.id = m.resolved_parking_lot_id
    WHERE m.resolution_status = 'resolved_existing_lot'
  `)
}

// buildInsertSql(run-pipeline-149)과 동일 컬럼. ai_summary는 NULL(후속 regen).
function buildWebSourceInsert(r: Row, score: number): string {
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
  const vals = [
    r.resolved_parking_lot_id,
    r.source,
    `${r.source_id}:${r.resolved_parking_lot_id}`,
    stripHtml(r.title),
    stripHtml(r.content),
    r.source_url,
    r.author,
    r.published_at,
    score,
    r.raw_source_id,
    r.sentiment_score,
    r.ai_difficulty_keywords,
    null, // ai_summary
    null, // ai_summary_updated_at
  ]
    .map(sqlVal)
    .join(', ')
  return `INSERT OR IGNORE INTO web_sources (${cols.join(', ')}) VALUES (${vals});`
}

function main() {
  console.log(`\n🔗 resolved_existing_lot → web_sources 재연결 — ${APPLY ? 'APPLY' : 'DRY-RUN'}`)
  console.log(`  관련성 게이트: scoreBlogRelevance >= ${MIN_SCORE}\n`)

  const rows = loadRows()
  console.log(`  대상 resolved_existing_lot 행: ${rows.length}`)

  const buckets = { '0-19': 0, '20-39': 0, '40-59': 0, '60-79': 0, '80-100': 0 }
  const statements: string[] = []
  const passSamples: string[] = []
  const skipSamples: string[] = []

  for (const r of rows) {
    const score = scoreBlogRelevance(r.title, r.content, r.lot_name, r.lot_address)
    if (score < 20) buckets['0-19']++
    else if (score < 40) buckets['20-39']++
    else if (score < 60) buckets['40-59']++
    else if (score < 80) buckets['60-79']++
    else buckets['80-100']++

    if (score >= MIN_SCORE) {
      statements.push(buildWebSourceInsert(r, score))
      if (passSamples.length < 12)
        passSamples.push(`    [${score}] "${stripHtml(r.title).slice(0, 40)}" → ${r.lot_name}`)
    } else if (skipSamples.length < 12) {
      skipSamples.push(`    [${score}] "${stripHtml(r.title).slice(0, 40)}" → ${r.lot_name}`)
    }
  }

  console.log(`\n  score 분포: ${JSON.stringify(buckets)}`)
  console.log(`  ▶ 링크 대상(>= ${MIN_SCORE}): ${statements.length}`)
  console.log(`  ▶ 게이트 탈락(< ${MIN_SCORE}, 우연매칭 의심): ${rows.length - statements.length}`)
  console.log(`\n  통과 샘플:\n${passSamples.join('\n')}`)
  console.log(`\n  탈락 샘플:\n${skipSamples.join('\n')}`)

  const outPath = resolve(import.meta.dir, '..', OUT_SQL)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, statements.join('\n') + '\n', 'utf-8')
  console.log(`\n  📄 INSERT ${statements.length}문 저장: ${outPath}`)

  if (APPLY) {
    d1ExecFile(outPath)
    console.log(
      `  ✅ 로컬 적용 완료. remote: wrangler d1 execute parking-db --remote --file=${OUT_SQL}`,
    )
  } else {
    console.log(`  (dry-run — 적용하려면 --apply)`)
  }
  console.log('')
}

main()
