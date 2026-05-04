/**
 * #148 Phase C — split a filter_v2 JSON input into N chunks for parallel
 * subagent dispatch.
 *
 * Usage:
 *   bun run scripts/split-filter-v2-input.ts <input.json> --chunks=4
 *     → input-c0.json, input-c1.json, ..., input-c{N-1}.json
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const args = process.argv.slice(2)
const inputPath = args.find((a) => !a.startsWith('--'))
const CHUNKS = parseInt(args.find((a) => a.startsWith('--chunks='))?.split('=')[1] ?? '4', 10)

if (!inputPath) {
  console.error('usage: bun run scripts/split-filter-v2-input.ts <input.json> --chunks=N')
  process.exit(1)
}

const data = JSON.parse(readFileSync(inputPath, 'utf-8')) as Array<Record<string, unknown>>
console.log(`input: ${inputPath} (${data.length} records)`)

const baseDir = dirname(inputPath)
const baseName = inputPath.replace(/\.json$/, '').replace(/^.*\//, '')

const perChunk = Math.ceil(data.length / CHUNKS)
const paths: string[] = []
for (let i = 0; i < CHUNKS; i++) {
  const slice = data.slice(i * perChunk, (i + 1) * perChunk)
  if (slice.length === 0) continue
  const path = join(baseDir, `${baseName}-c${i}.json`)
  writeFileSync(path, JSON.stringify(slice, null, 2), 'utf-8')
  console.log(`  ${path} (${slice.length} records)`)
  paths.push(path)
}

console.log(`\n${paths.length} chunks written.`)
