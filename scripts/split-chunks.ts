/**
 * data/lots_for_summary.json → data/chunks/chunk-NNN.json (50건씩)
 */
import { readFileSync, writeFileSync } from 'fs'

const INPUT = 'data/lots_for_summary.json'
const OUTDIR = 'data/chunks'
const SIZE = 50

const all = JSON.parse(readFileSync(INPUT, 'utf-8')) as unknown[]
const total = all.length
const numChunks = Math.ceil(total / SIZE)

for (let i = 0; i < numChunks; i++) {
  const slice = all.slice(i * SIZE, (i + 1) * SIZE)
  const name = `${OUTDIR}/chunk-${String(i).padStart(3, '0')}.json`
  writeFileSync(name, JSON.stringify(slice, null, 2), 'utf-8')
}

console.log(`split ${total} lots into ${numChunks} chunks of ${SIZE}`)
console.log(
  `output: ${OUTDIR}/chunk-000.json ~ chunk-${String(numChunks - 1).padStart(3, '0')}.json`,
)
