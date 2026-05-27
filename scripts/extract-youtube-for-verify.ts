/**
 * web_sources_raw의 미검증 youtube_video 추출 → youtube-video-verifier agent 입력 JSON 생성.
 *
 * 추출 조건:
 *   - source = 'youtube_video'
 *   - filter_passed IS NULL (아직 검증 안 됨)
 *   - search_lot_hint 가 parking_lots에 존재
 *
 * 입력 JSON에 hint lot 정보(name/address) JOIN해서 포함 — agent가 매칭 판정에 사용.
 *
 * 청크 분할: --shards N → data/youtube-verify-input-{01..NN}.json
 *
 * Usage:
 *   bun run scripts/extract-youtube-for-verify.ts --remote --limit=200 --shards=5
 *   bun run scripts/extract-youtube-for-verify.ts --remote --limit=200             # 단일 파일
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { d1Query, isRemote } from './lib/d1'

const args = process.argv.slice(2)
const LIMIT = parseInt(args.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? '200', 10)
const SHARDS = parseInt(args.find((a) => a.startsWith('--shards='))?.split('=')[1] ?? '1', 10)
const OUTPUT_DIR =
  args.find((a) => a.startsWith('--output-dir='))?.split('=')[1] ?? 'data/youtube-verify'

interface PendingRow {
  raw_id: number
  video_url: string
  video_title: string
  video_description: string
  full_text: string
  channel: string | null
  published_at: string | null
  hint_lot_id: string
  hint_lot_name: string
  hint_lot_address: string
}

interface AgentInput {
  raw_id: number
  video_url: string
  video_title: string
  video_description: string
  video_tags: string
  channel: string | null
  published_at: string | null
  hint_lot_id: string
  hint_lot_name: string
  hint_lot_address: string
}

function fetchPending(limit: number): PendingRow[] {
  return d1Query<PendingRow>(`
    SELECT r.id AS raw_id,
           r.source_url AS video_url,
           r.title AS video_title,
           r.content AS video_description,
           r.full_text AS full_text,
           r.author AS channel,
           r.published_at AS published_at,
           r.search_lot_hint AS hint_lot_id,
           pl.name AS hint_lot_name,
           pl.address AS hint_lot_address
    FROM web_sources_raw r
    JOIN parking_lots pl ON pl.id = r.search_lot_hint
    WHERE r.source = 'youtube_video'
      AND r.filter_passed IS NULL
      AND r.search_lot_hint IS NOT NULL
    ORDER BY r.id ASC
    LIMIT ${limit}
  `)
}

/**
 * full_text는 "title\n\ndescription\n\nTags: a, b, c" 형태로 적재됨.
 * tags 부분만 분리해서 video_tags로 추출.
 */
function extractTags(fullText: string): string {
  const match = fullText.match(/\n\nTags:\s*(.+)$/)
  return match?.[1]?.trim() ?? ''
}

function writeShard(rows: AgentInput[], path: string): void {
  writeFileSync(path, JSON.stringify(rows, null, 2), 'utf-8')
}

function main(): void {
  console.log(`\n📤 extract-youtube-for-verify — ${isRemote ? 'remote' : 'local'} D1`)
  console.log(`   limit=${LIMIT} shards=${SHARDS} output-dir=${OUTPUT_DIR}`)

  const rows = fetchPending(LIMIT)
  console.log(`   fetched ${rows.length} rows`)

  const inputs: AgentInput[] = rows.map((r) => ({
    raw_id: r.raw_id,
    video_url: r.video_url,
    video_title: r.video_title,
    video_description: r.video_description,
    video_tags: extractTags(r.full_text ?? ''),
    channel: r.channel,
    published_at: r.published_at,
    hint_lot_id: r.hint_lot_id,
    hint_lot_name: r.hint_lot_name,
    hint_lot_address: r.hint_lot_address,
  }))

  const outputDir = resolve(import.meta.dir, '..', OUTPUT_DIR)
  mkdirSync(outputDir, { recursive: true })

  if (SHARDS === 1) {
    const path = resolve(outputDir, 'youtube-verify-input.json')
    writeShard(inputs, path)
    console.log(`✅ wrote ${path} (${inputs.length} records)`)
  } else {
    const chunkSize = Math.ceil(inputs.length / SHARDS)
    for (let i = 0; i < SHARDS; i++) {
      const chunk = inputs.slice(i * chunkSize, (i + 1) * chunkSize)
      if (chunk.length === 0) continue
      const idx = String(i + 1).padStart(2, '0')
      const path = resolve(outputDir, `youtube-verify-input-${idx}.json`)
      writeShard(chunk, path)
      console.log(`✅ wrote ${path} (${chunk.length} records)`)
    }
  }

  console.log(`\n다음 단계:`)
  console.log(`   1. youtube-video-verifier 에이전트 호출 (Task 도구, sliding window 7-in-flight)`)
  console.log(`      입력: ${outputDir}/youtube-verify-input*.json`)
  console.log(`      출력: 같은 경로의 -verified.json`)
  console.log(`   2. 결과 적용:`)
  console.log(`      bun run scripts/apply-youtube-verify.ts --remote --input-dir=${OUTPUT_DIR}`)
}

main()
