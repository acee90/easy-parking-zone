/**
 * tips-local.sqlite → lots_for_tips.json 빌드
 *
 * Usage:
 *   bun run scripts/build-lot-tips-input.ts
 *   bun run scripts/build-lot-tips-input.ts --chunks=4 --output-dir=data
 */
import { Database } from 'bun:sqlite'
import { mkdirSync, writeFileSync } from 'fs'
import { resolve } from 'path'

const args = process.argv.slice(2)
const chunks = parseInt(args.find((a) => a.startsWith('--chunks='))?.split('=')[1] ?? '1', 10)
const outputDir = args.find((a) => a.startsWith('--output-dir='))?.split('=')[1] ?? 'data'
const limit = parseInt(args.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? '999999', 10)

const LOCAL_DUMP_PATH = resolve(import.meta.dir, '../data/tips-local.sqlite')
const db = new Database(LOCAL_DUMP_PATH, { readonly: true })

// 대상 lots 조회
const lots = db
  .query(
    `
  SELECT p.id, p.name, p.address, s.ai_summary AS existing_summary
  FROM parking_lots p
  INNER JOIN parking_lot_stats s ON s.parking_lot_id = p.id
  WHERE s.ai_summary IS NOT NULL AND s.ai_summary != ''
    AND (s.ai_tip_pricing IS NULL OR s.ai_tip_visit IS NULL OR s.ai_tip_alternative IS NULL)
    AND EXISTS (SELECT 1 FROM web_sources w WHERE w.parking_lot_id = p.id)
  ORDER BY COALESCE(s.final_score, 0) DESC
  LIMIT ${limit}
`,
  )
  .all() as { id: string; name: string; address: string; existing_summary: string }[]

console.log(`대상 ${lots.length}건`)

// 각 lot에 web_summaries, reviews 붙이기
const wsStmt = db.prepare(
  `SELECT ai_summary FROM web_sources WHERE parking_lot_id = ? ORDER BY relevance_score DESC LIMIT 30`,
)
const rvStmt = db.prepare(
  `SELECT overall_score, entry_score, space_score, passage_score, exit_score, comment
   FROM user_reviews WHERE parking_lot_id = ? ORDER BY created_at DESC LIMIT 20`,
)

interface LotInput {
  id: string
  name: string
  address: string
  existing_summary: string
  web_summaries: string[]
  reviews: string[]
}

const records: LotInput[] = lots.map((lot) => {
  const webRows = wsStmt.all(lot.id) as { ai_summary: string }[]
  const rvRows = rvStmt.all(lot.id) as {
    overall_score: number
    entry_score: number
    space_score: number
    passage_score: number
    exit_score: number
    comment: string | null
  }[]

  const reviews = rvRows.map(
    (r, i) =>
      `[R${i + 1}] 종합 ${r.overall_score}/5 · 진입 ${r.entry_score} · 주차면 ${r.space_score} · 통로 ${r.passage_score} · 출차 ${r.exit_score}${r.comment ? ` — "${r.comment.slice(0, 200)}"` : ''}`,
  )

  return {
    id: lot.id,
    name: lot.name,
    address: lot.address,
    existing_summary: lot.existing_summary,
    web_summaries: webRows.map((r) => r.ai_summary),
    reviews,
  }
})

db.close()
mkdirSync(outputDir, { recursive: true })

if (chunks === 1) {
  const outPath = resolve(outputDir, 'lots_for_tips.json')
  writeFileSync(outPath, JSON.stringify(records, null, 2))
  console.log(`저장 → ${outPath}`)
} else {
  const size = Math.ceil(records.length / chunks)
  for (let i = 0; i < chunks; i++) {
    const chunk = records.slice(i * size, (i + 1) * size)
    const outPath = resolve(outputDir, `lots_for_tips_chunk_${i}.json`)
    writeFileSync(outPath, JSON.stringify(chunk, null, 2))
    console.log(`청크 ${i}: ${chunk.length}건 → ${outPath}`)
  }
}
