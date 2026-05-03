/**
 * Quick cleaner — replace UPDATE statements containing PDF binary markers
 * with safe error UPDATEs. Side effect of fetching PDF URLs through the ddg
 * extractor: full_text gets binary which breaks SQLite parsing of the file.
 *
 * Usage: bun run scripts/clean-pdf-updates.ts <files...>
 */
import { readFileSync, writeFileSync } from 'node:fs'

const PDF_MARKER = /%%EOF|%PDF-/

const files = process.argv.slice(2)
if (files.length === 0) {
  console.error('usage: bun run scripts/clean-pdf-updates.ts <files...>')
  process.exit(1)
}

// Walk the file character-by-character, tracking when we're inside a SQL
// string literal. UPDATE statements end at `;` outside any string.
function splitUpdates(content: string): string[] {
  const stmts: string[] = []
  let inStr = false
  let start = 0
  for (let i = 0; i < content.length; i++) {
    const ch = content[i]
    if (ch === "'") {
      if (inStr && content[i + 1] === "'") {
        i++ // skip escaped ''
        continue
      }
      inStr = !inStr
      continue
    }
    if (ch === ';' && !inStr) {
      const stmt = content.slice(start, i + 1)
      stmts.push(stmt)
      start = i + 1
      // skip following whitespace/newline so we don't push empty stmts
      while (start < content.length && /\s/.test(content[start])) start++
      i = start - 1
    }
  }
  // tail (no trailing semicolon)
  const tail = content.slice(start).trim()
  if (tail.length > 0) stmts.push(tail)
  return stmts
}

let totalReplaced = 0

for (const path of files) {
  const original = readFileSync(path, 'utf-8')
  const stmts = splitUpdates(original)
  let replacedInFile = 0
  const cleaned = stmts.map((stmt) => {
    if (!PDF_MARKER.test(stmt)) return stmt
    // extract id from "WHERE id = N;"
    const m = stmt.match(/WHERE id = (\d+);/)
    if (!m) return stmt
    replacedInFile++
    totalReplaced++
    return `UPDATE web_sources SET full_text = NULL, full_text_length = 0, full_text_status = 'error', full_text_fetched_at = datetime('now') WHERE id = ${m[1]};`
  })
  if (replacedInFile > 0) {
    writeFileSync(path, cleaned.join('\n'), 'utf-8')
    console.log(`${path}: replaced ${replacedInFile} PDF UPDATEs (${stmts.length} total stmts)`)
  } else {
    console.log(`${path}: clean (${stmts.length} stmts)`)
  }
}

console.log(`\ntotal replaced: ${totalReplaced}`)
