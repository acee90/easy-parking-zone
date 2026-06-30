/**
 * gen-aifilter-workflow.ts — run-pipeline Stage 3 driver.
 *
 * Reads the canonical workflow logic from `.claude/workflows/ai-filter-fanout.js`, inlines the
 * medium-candidates chunk list discovered in <DIR>, and writes a runnable copy. The chunk list is
 * inlined (not passed via Workflow `args`) because this harness does not plumb `args` into workflow
 * scripts. Invoke the emitted file with Workflow({ scriptPath: "<emitted>" }).
 *
 *   bun run scripts/gen-aifilter-workflow.ts <DIR>
 *
 * Prints the emitted scriptPath on the last stdout line.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = process.argv[2]
if (!dir) {
  console.error('usage: bun run scripts/gen-aifilter-workflow.ts <DIR>')
  process.exit(1)
}
if (!existsSync(dir)) {
  console.error(`DIR not found: ${dir}`)
  process.exit(1)
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const templatePath = resolve(repoRoot, '.claude/workflows/ai-filter-fanout.js')
const template = readFileSync(templatePath, 'utf-8')

const MARKER = '[] /* __CHUNKS__ */'
if (!template.includes(MARKER)) {
  console.error(`injection marker not found in ${templatePath} — expected: ${MARKER}`)
  process.exit(1)
}

const chunks = readdirSync(dir)
  .filter((f) => /^medium-candidates.*\.json$/.test(f))
  .sort()
  .map((f) => ({
    in: `${dir}/${f}`,
    out: `${dir}/${f.replace('medium-candidates', 'ai-results')}`,
  }))

if (chunks.length === 0) {
  console.error(`no medium-candidates*.json found in ${dir}`)
  process.exit(1)
}

const inlined = `${JSON.stringify(chunks)} /* __CHUNKS__ */`
const runnable = template.replace(MARKER, inlined)

const outPath = `${dir}/ai-filter-run.workflow.js`
writeFileSync(outPath, runnable)

console.error(`inlined ${chunks.length} chunks → ${outPath}`)
console.log(outPath)
