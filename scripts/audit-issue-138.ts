/**
 * Issue #138 Phase 0 audit — measures input data shape before designing v2 schema.
 *
 * Outputs a markdown report at data/issue-138-audit.md.
 *
 * Usage:
 *   bun run scripts/audit-issue-138.ts --remote
 */
import { mkdirSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { d1Query, isRemote } from './lib/d1'

interface MetaNullRow {
  total: number
  null_address: number
  null_weekday: number
  null_saturday: number
  null_holiday: number
  null_base_fee: number
  null_extra_fee: number
  null_daily_max: number
  null_or_zero_spaces: number
  null_phone: number
  null_payment: number
  null_notes: number
  null_poi: number
  curated: number
  has_curation_reason: number
  free_lots: number
}

interface SummaryLenRow {
  bucket: string
  n: number
}

interface ReviewBucketRow {
  bucket: string
  n: number
}

interface NearbyRow {
  total_nearby: number
  lots_with_nearby: number
  lots_with_tip: number
  avg_tips_per_lot: number
}

interface WebRow {
  bucket: string
  n: number
}

function pct(n: number, total: number): string {
  return `${((n / total) * 100).toFixed(1)}%`
}

function bucketSummary(): SummaryLenRow[] {
  return d1Query<SummaryLenRow>(`
    SELECT bucket, COUNT(*) AS n FROM (
      SELECT CASE
        WHEN ai_summary IS NULL OR ai_summary = '' THEN '0_empty'
        WHEN LENGTH(ai_summary) < 100 THEN '1_under_100'
        WHEN LENGTH(ai_summary) < 200 THEN '2_100_200'
        WHEN LENGTH(ai_summary) < 300 THEN '3_200_300'
        WHEN LENGTH(ai_summary) < 400 THEN '4_300_400'
        WHEN LENGTH(ai_summary) < 600 THEN '5_400_600'
        WHEN LENGTH(ai_summary) < 800 THEN '6_600_800'
        ELSE '7_800_plus'
      END AS bucket
      FROM parking_lot_stats
    )
    GROUP BY bucket ORDER BY bucket
  `)
}

function metaNull(): MetaNullRow {
  const rows = d1Query<MetaNullRow>(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN address IS NULL OR address = '' THEN 1 ELSE 0 END) AS null_address,
      SUM(CASE WHEN weekday_start IS NULL THEN 1 ELSE 0 END) AS null_weekday,
      SUM(CASE WHEN saturday_start IS NULL THEN 1 ELSE 0 END) AS null_saturday,
      SUM(CASE WHEN holiday_start IS NULL THEN 1 ELSE 0 END) AS null_holiday,
      SUM(CASE WHEN base_fee IS NULL THEN 1 ELSE 0 END) AS null_base_fee,
      SUM(CASE WHEN extra_fee IS NULL THEN 1 ELSE 0 END) AS null_extra_fee,
      SUM(CASE WHEN daily_max IS NULL THEN 1 ELSE 0 END) AS null_daily_max,
      SUM(CASE WHEN total_spaces = 0 OR total_spaces IS NULL THEN 1 ELSE 0 END) AS null_or_zero_spaces,
      SUM(CASE WHEN phone IS NULL OR phone = '' THEN 1 ELSE 0 END) AS null_phone,
      SUM(CASE WHEN payment_methods IS NULL OR payment_methods = '' THEN 1 ELSE 0 END) AS null_payment,
      SUM(CASE WHEN notes IS NULL OR notes = '' THEN 1 ELSE 0 END) AS null_notes,
      SUM(CASE WHEN poi_tags IS NULL OR poi_tags = '' OR poi_tags = '[]' THEN 1 ELSE 0 END) AS null_poi,
      SUM(CASE WHEN is_curated = 1 THEN 1 ELSE 0 END) AS curated,
      SUM(CASE WHEN curation_reason IS NOT NULL AND curation_reason != '' THEN 1 ELSE 0 END) AS has_curation_reason,
      SUM(CASE WHEN is_free = 1 THEN 1 ELSE 0 END) AS free_lots
    FROM parking_lots
  `)
  return rows[0]
}

function reviewBuckets(): ReviewBucketRow[] {
  return d1Query<ReviewBucketRow>(`
    SELECT bucket, COUNT(*) AS n FROM (
      SELECT p.id, CASE
        WHEN c.cnt IS NULL OR c.cnt = 0 THEN '0_none'
        WHEN c.cnt <= 2 THEN '1_1_2'
        WHEN c.cnt <= 5 THEN '2_3_5'
        ELSE '3_6plus'
      END AS bucket
      FROM parking_lots p
      LEFT JOIN (
        SELECT parking_lot_id, COUNT(*) AS cnt FROM user_reviews GROUP BY parking_lot_id
      ) c ON c.parking_lot_id = p.id
    )
    GROUP BY bucket ORDER BY bucket
  `)
}

function webBuckets(): WebRow[] {
  return d1Query<WebRow>(`
    SELECT bucket, COUNT(*) AS n FROM (
      SELECT p.id, CASE
        WHEN c.cnt IS NULL OR c.cnt = 0 THEN '0_none'
        WHEN c.cnt <= 2 THEN '1_1_2'
        WHEN c.cnt <= 5 THEN '2_3_5'
        WHEN c.cnt <= 15 THEN '3_6_15'
        ELSE '4_16plus'
      END AS bucket
      FROM parking_lots p
      LEFT JOIN (
        SELECT parking_lot_id, COUNT(*) AS cnt
        FROM web_sources
        WHERE ai_summary IS NOT NULL AND ai_summary != ''
        GROUP BY parking_lot_id
      ) c ON c.parking_lot_id = p.id
    )
    GROUP BY bucket ORDER BY bucket
  `)
}

function nearbyStats(): NearbyRow {
  const rows = d1Query<NearbyRow>(`
    SELECT
      (SELECT COUNT(*) FROM nearby_places) AS total_nearby,
      (SELECT COUNT(DISTINCT parking_lot_id) FROM nearby_places) AS lots_with_nearby,
      (SELECT COUNT(DISTINCT parking_lot_id) FROM nearby_places WHERE tip IS NOT NULL AND tip != '') AS lots_with_tip,
      (SELECT CAST(COUNT(*) AS REAL) / NULLIF(COUNT(DISTINCT parking_lot_id), 0) FROM nearby_places WHERE tip IS NOT NULL AND tip != '') AS avg_tips_per_lot
  `)
  return rows[0]
}

interface StatsCoverage {
  total: number
  has_final_score: number
  high_reliability: number
  medium_reliability: number
  low_reliability: number
}

function statsCoverage(): StatsCoverage {
  const rows = d1Query<StatsCoverage>(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN final_score IS NOT NULL THEN 1 ELSE 0 END) AS has_final_score,
      SUM(CASE WHEN reliability = 'HIGH' THEN 1 ELSE 0 END) AS high_reliability,
      SUM(CASE WHEN reliability = 'MEDIUM' THEN 1 ELSE 0 END) AS medium_reliability,
      SUM(CASE WHEN reliability = 'LOW' THEN 1 ELSE 0 END) AS low_reliability
    FROM parking_lot_stats
  `)
  return rows[0]
}

interface SampleRow {
  id: string
  name: string
  address: string
  ai_summary_len: number
  web_count: number
  review_count: number
  nearby_count: number
}

function pickSampleLots(): SampleRow[] {
  return d1Query<SampleRow>(`
    WITH ranked AS (
      SELECT
        p.id, p.name, p.address,
        COALESCE(LENGTH(s.ai_summary), 0) AS ai_summary_len,
        (SELECT COUNT(*) FROM web_sources w WHERE w.parking_lot_id = p.id AND w.ai_summary IS NOT NULL AND w.ai_summary != '') AS web_count,
        (SELECT COUNT(*) FROM user_reviews r WHERE r.parking_lot_id = p.id) AS review_count,
        (SELECT COUNT(*) FROM nearby_places n WHERE n.parking_lot_id = p.id) AS nearby_count,
        s.final_score,
        NTILE(4) OVER (ORDER BY COALESCE(s.final_score, 0)) AS quartile
      FROM parking_lots p
      LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
      WHERE p.address IS NOT NULL AND p.address != ''
    )
    SELECT id, name, address, ai_summary_len, web_count, review_count, nearby_count
    FROM (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY quartile ORDER BY RANDOM()) AS rn
      FROM ranked
    )
    WHERE rn <= 25
    ORDER BY quartile, rn
  `)
}

function reviewExtremes() {
  return d1Query<{ tag: string; n: number }>(`
    SELECT 'lots_with_meta_only' AS tag, COUNT(*) AS n FROM parking_lots p
    LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
    WHERE NOT EXISTS (SELECT 1 FROM web_sources w WHERE w.parking_lot_id = p.id AND w.ai_summary IS NOT NULL AND w.ai_summary != '')
      AND NOT EXISTS (SELECT 1 FROM user_reviews r WHERE r.parking_lot_id = p.id)
      AND NOT EXISTS (SELECT 1 FROM nearby_places n WHERE n.parking_lot_id = p.id)
    UNION ALL
    SELECT 'lots_with_any_signal', COUNT(*) FROM parking_lots p
    WHERE EXISTS (SELECT 1 FROM web_sources w WHERE w.parking_lot_id = p.id AND w.ai_summary IS NOT NULL AND w.ai_summary != '')
       OR EXISTS (SELECT 1 FROM user_reviews r WHERE r.parking_lot_id = p.id)
       OR EXISTS (SELECT 1 FROM nearby_places n WHERE n.parking_lot_id = p.id)
  `)
}

function main() {
  console.log(`\n📊 Issue #138 audit (${isRemote ? 'remote' : 'local'})\n`)

  console.log('  1/7 meta null rates...')
  const meta = metaNull()
  console.log('  2/7 ai_summary length buckets...')
  const sumBuckets = bucketSummary()
  console.log('  3/7 review per-lot buckets...')
  const revBuckets = reviewBuckets()
  console.log('  4/7 web_sources per-lot buckets...')
  const webBucketsRows = webBuckets()
  console.log('  5/7 nearby_places coverage...')
  const nearby = nearbyStats()
  console.log('  6/7 parking_lot_stats coverage...')
  const stats = statsCoverage()
  console.log('  7/7 review extremes (meta-only vs any-signal)...')
  const extremes = reviewExtremes()
  console.log('  8/7 sampling 100 lots (4 quartiles × 25)...')
  const sample = pickSampleLots()

  const total = meta.total
  const lines: string[] = []
  lines.push(`# Issue #138 Phase 0 — Data Audit`)
  lines.push(``)
  lines.push(`- Source: \`${isRemote ? 'remote' : 'local'}\` D1 \`parking-db\``)
  lines.push(`- Generated: ${new Date().toISOString()}`)
  lines.push(`- Total parking_lots: **${total.toLocaleString()}**`)
  lines.push(``)

  lines.push(`## 1. parking_lots column null rates (n=${total})`)
  lines.push(``)
  lines.push(`| Field | Null/Empty | % |`)
  lines.push(`|---|---:|---:|`)
  const m = meta
  lines.push(`| address | ${m.null_address} | ${pct(m.null_address, total)} |`)
  lines.push(`| weekday_start | ${m.null_weekday} | ${pct(m.null_weekday, total)} |`)
  lines.push(`| saturday_start | ${m.null_saturday} | ${pct(m.null_saturday, total)} |`)
  lines.push(`| holiday_start | ${m.null_holiday} | ${pct(m.null_holiday, total)} |`)
  lines.push(`| base_fee | ${m.null_base_fee} | ${pct(m.null_base_fee, total)} |`)
  lines.push(`| extra_fee | ${m.null_extra_fee} | ${pct(m.null_extra_fee, total)} |`)
  lines.push(`| daily_max | ${m.null_daily_max} | ${pct(m.null_daily_max, total)} |`)
  lines.push(
    `| total_spaces (null/0) | ${m.null_or_zero_spaces} | ${pct(m.null_or_zero_spaces, total)} |`,
  )
  lines.push(`| phone | ${m.null_phone} | ${pct(m.null_phone, total)} |`)
  lines.push(`| payment_methods | ${m.null_payment} | ${pct(m.null_payment, total)} |`)
  lines.push(`| notes | ${m.null_notes} | ${pct(m.null_notes, total)} |`)
  lines.push(`| poi_tags (null/empty/[]) | ${m.null_poi} | ${pct(m.null_poi, total)} |`)
  lines.push(``)
  lines.push(`- **is_free** lots: ${m.free_lots} (${pct(m.free_lots, total)})`)
  lines.push(
    `- **is_curated**: ${m.curated} (${pct(m.curated, total)}) / has curation_reason: ${m.has_curation_reason} (${pct(m.has_curation_reason, total)})`,
  )
  lines.push(``)

  lines.push(`## 2. parking_lot_stats.ai_summary length distribution`)
  lines.push(``)
  lines.push(`| Bucket | Count |`)
  lines.push(`|---|---:|`)
  for (const r of sumBuckets) lines.push(`| ${r.bucket} | ${r.n} |`)
  lines.push(``)

  lines.push(`## 3. user_reviews per-lot distribution`)
  lines.push(``)
  lines.push(`| Bucket | Count |`)
  lines.push(`|---|---:|`)
  for (const r of revBuckets) lines.push(`| ${r.bucket} | ${r.n} |`)
  lines.push(``)

  lines.push(`## 4. web_sources (ai_summary present) per-lot distribution`)
  lines.push(``)
  lines.push(`| Bucket | Count |`)
  lines.push(`|---|---:|`)
  for (const r of webBucketsRows) lines.push(`| ${r.bucket} | ${r.n} |`)
  lines.push(``)

  lines.push(`## 5. nearby_places coverage`)
  lines.push(``)
  lines.push(`- total nearby rows: ${nearby.total_nearby}`)
  lines.push(
    `- lots with ≥1 nearby: ${nearby.lots_with_nearby} (${pct(nearby.lots_with_nearby, total)})`,
  )
  lines.push(
    `- lots with ≥1 nearby tip: ${nearby.lots_with_tip} (${pct(nearby.lots_with_tip, total)})`,
  )
  lines.push(`- avg tips per lot (lots-with-tip): ${nearby.avg_tips_per_lot?.toFixed(1) ?? 'n/a'}`)
  lines.push(``)

  lines.push(`## 6. parking_lot_stats coverage`)
  lines.push(``)
  lines.push(`- rows: ${stats.total}`)
  lines.push(
    `- has final_score: ${stats.has_final_score} (${pct(stats.has_final_score, stats.total)})`,
  )
  lines.push(
    `- reliability HIGH/MEDIUM/LOW: ${stats.high_reliability} / ${stats.medium_reliability} / ${stats.low_reliability}`,
  )
  lines.push(``)

  lines.push(`## 7. Signal extremes`)
  lines.push(``)
  for (const e of extremes) lines.push(`- ${e.tag}: ${e.n} (${pct(e.n, total)})`)
  lines.push(``)

  lines.push(`## 8. Sample 100 lots (4 quartiles × 25, by final_score)`)
  lines.push(``)
  lines.push(`Sample saved to \`data/issue-138-sample-100.json\` for Phase 4 pilot.`)
  lines.push(``)
  lines.push(`Composition:`)
  const sampleByQuartile = [0, 0, 0, 0]
  for (let i = 0; i < sample.length; i++) {
    sampleByQuartile[Math.floor(i / 25)]++
  }
  lines.push(`- Q1 (lowest score): ${sampleByQuartile[0]}`)
  lines.push(`- Q2: ${sampleByQuartile[1]}`)
  lines.push(`- Q3: ${sampleByQuartile[2]}`)
  lines.push(`- Q4 (highest score): ${sampleByQuartile[3]}`)
  lines.push(``)

  lines.push(`## Decisions taken from this audit`)
  lines.push(``)
  lines.push(`- Confirm which meta fields to include in v2 input (drop fields with >80% null)`)
  lines.push(`- Choose MIN_LOT_SUMMARY_LENGTH threshold based on bucket distribution`)
  lines.push(`- Confirm sample composition is balanced for pilot`)
  lines.push(``)

  const outDir = resolve(import.meta.dir, '..', 'data')
  mkdirSync(outDir, { recursive: true })
  writeFileSync(resolve(outDir, 'issue-138-audit.md'), lines.join('\n'), 'utf-8')
  writeFileSync(
    resolve(outDir, 'issue-138-sample-100.json'),
    JSON.stringify(sample, null, 2),
    'utf-8',
  )

  console.log(`\n✅ wrote data/issue-138-audit.md (${lines.length} lines)`)
  console.log(`✅ wrote data/issue-138-sample-100.json (${sample.length} lots)`)
}

main()
