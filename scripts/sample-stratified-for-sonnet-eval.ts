/**
 * 0.5점 단위 9개 구간별로 web_sources.sentiment_score에서 N개 무작위 추출.
 *
 * Usage:
 *   bun run scripts/sample-stratified-for-sonnet-eval.ts [--round N] [--per-bucket K] [--exclude FILE]
 *
 *   --round N         : 라운드 번호 (기본 1) - 출력 파일명에 사용
 *   --per-bucket K    : 각 구간당 샘플 수 (기본 5)
 *   --exclude FILE    : 기존 답지 JSON (이미 평가된 ID 제외)
 *
 * 출력: data/sentiment-eval/sonnet/round-N-input.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { d1Query } from './lib/d1'

const args = process.argv.slice(2)
function flagValue(name: string, def: string): string {
  const i = args.indexOf(name)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def
}

const ROUND = parseInt(flagValue('--round', '1'), 10)
const PER_BUCKET = parseInt(flagValue('--per-bucket', '5'), 10)
const EXCLUDE_FILE = flagValue('--exclude', '')

const BUCKETS: { name: string; whereExpr: string }[] = [
  { name: '1.0', whereExpr: 'ws.sentiment_score >= 1.0 AND ws.sentiment_score < 1.5' },
  { name: '1.5', whereExpr: 'ws.sentiment_score >= 1.5 AND ws.sentiment_score < 2.0' },
  { name: '2.0', whereExpr: 'ws.sentiment_score >= 2.0 AND ws.sentiment_score < 2.5' },
  { name: '2.5', whereExpr: 'ws.sentiment_score >= 2.5 AND ws.sentiment_score < 3.0' },
  { name: '3.0', whereExpr: 'ws.sentiment_score >= 3.0 AND ws.sentiment_score < 3.5' },
  { name: '3.5', whereExpr: 'ws.sentiment_score >= 3.5 AND ws.sentiment_score < 4.0' },
  { name: '4.0', whereExpr: 'ws.sentiment_score >= 4.0 AND ws.sentiment_score < 4.5' },
  { name: '4.5', whereExpr: 'ws.sentiment_score >= 4.5 AND ws.sentiment_score < 5.0' },
  { name: '5.0', whereExpr: 'ws.sentiment_score = 5.0' },
]

const exclude = new Set<number>()
if (EXCLUDE_FILE && existsSync(EXCLUDE_FILE)) {
  const data = JSON.parse(readFileSync(EXCLUDE_FILE, 'utf-8')) as { id: number }[]
  for (const r of data) exclude.add(r.id)
  console.log(`exclude: ${exclude.size}건 (from ${EXCLUDE_FILE})`)
}

function extractParkingContext(text: string, maxLen = 1500): string {
  const stripped = text
    .replace(/!?\[[^\]\n]*\]\([^)\n]*\)/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const windows: { start: number; end: number }[] = []
  let pos = 0
  while (true) {
    const idx = stripped.indexOf('주차', pos)
    if (idx === -1) break
    const start = Math.max(0, idx - 200)
    const end = Math.min(stripped.length, idx + 200)
    if (windows.length > 0 && windows[windows.length - 1].end >= start) {
      windows[windows.length - 1].end = Math.max(windows[windows.length - 1].end, end)
    } else {
      windows.push({ start, end })
    }
    pos = idx + 2
  }
  let result = windows.map((w) => stripped.slice(w.start, w.end)).join(' … ')
  if (result.length > maxLen) result = result.slice(0, maxLen) + '...'
  return result
}

interface Row {
  id: number
  parking_lot_id: string
  lot_name: string
  title: string
  sentiment_score: number
  full_text: string
}

const samples: Array<{
  id: number
  parking_lot_id: string
  lot_name: string
  title: string
  current_score: number
  bucket: string
  parking_context: string
}> = []

for (const b of BUCKETS) {
  const excludeClause = exclude.size > 0 ? `AND ws.id NOT IN (${[...exclude].join(',')})` : ''
  const rows = d1Query<Row>(`
    SELECT ws.id, ws.parking_lot_id, p.name AS lot_name, ws.title,
           ws.sentiment_score, wsr.full_text
    FROM web_sources ws
    JOIN web_sources_raw wsr ON wsr.id = ws.raw_source_id
    JOIN parking_lots p ON p.id = ws.parking_lot_id
    WHERE ${b.whereExpr}
      ${excludeClause}
    ORDER BY random()
    LIMIT ${PER_BUCKET}
  `)
  console.log(`bucket ${b.name}: ${rows.length}건 추출`)
  for (const r of rows) {
    samples.push({
      id: r.id,
      parking_lot_id: r.parking_lot_id,
      lot_name: r.lot_name,
      title: (r.title || '').slice(0, 100),
      current_score: r.sentiment_score,
      bucket: b.name,
      parking_context: extractParkingContext(r.full_text),
    })
  }
}

const dir = 'data/sentiment-eval/sonnet'
if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
const path = `${dir}/round-${ROUND}-input.json`
writeFileSync(path, JSON.stringify(samples, null, 2), 'utf-8')
console.log(`\nsaved: ${path} (${samples.length}건)`)
