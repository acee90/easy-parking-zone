/**
 * Issue #138 audit — show 3 real lot examples (signal-rich / signal-mid / meta-only)
 * to make the input shape and length tradeoff concrete.
 *
 * Usage: bun run scripts/audit-show-examples.ts --remote
 */
import { d1Query } from './lib/d1'

interface Lot {
  id: string
  name: string
  type: string
  address: string
  total_spaces: number | null
  weekday_start: string | null
  weekday_end: string | null
  saturday_start: string | null
  saturday_end: string | null
  holiday_start: string | null
  holiday_end: string | null
  is_free: number
  base_time: number | null
  base_fee: number | null
  extra_time: number | null
  extra_fee: number | null
  daily_max: number | null
  phone: string | null
  payment_methods: string | null
  notes: string | null
  poi_tags: string | null
  is_curated: number
  curation_tag: string | null
  curation_reason: string | null
  final_score: number | null
}

function fetchLot(id: string): Lot | undefined {
  return d1Query<Lot>(`
    SELECT p.id, p.name, p.type, p.address, p.total_spaces,
      p.weekday_start, p.weekday_end, p.saturday_start, p.saturday_end,
      p.holiday_start, p.holiday_end, p.is_free, p.base_time, p.base_fee,
      p.extra_time, p.extra_fee, p.daily_max, p.phone, p.payment_methods,
      p.notes, p.poi_tags, p.is_curated, p.curation_tag, p.curation_reason,
      s.final_score
    FROM parking_lots p
    LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
    WHERE p.id = '${id.replace(/'/g, "''")}'
  `)[0]
}

function fetchWebSummaries(id: string): string[] {
  return d1Query<{ ai_summary: string }>(`
    SELECT ai_summary FROM web_sources
    WHERE parking_lot_id = '${id}' AND ai_summary IS NOT NULL AND ai_summary != ''
    ORDER BY relevance_score DESC LIMIT 5
  `).map((r) => r.ai_summary)
}

function fetchReviews(id: string) {
  return d1Query<{
    overall_score: number
    entry_score: number
    space_score: number
    passage_score: number
    exit_score: number
    comment: string | null
  }>(`
    SELECT overall_score, entry_score, space_score, passage_score, exit_score, comment
    FROM user_reviews WHERE parking_lot_id = '${id}' ORDER BY created_at DESC LIMIT 5
  `)
}

// 1. signal-rich: web ≥ 6
const richIds = d1Query<{ id: string }>(`
  SELECT p.id FROM parking_lots p
  WHERE (SELECT COUNT(*) FROM web_sources w WHERE w.parking_lot_id = p.id
         AND w.ai_summary IS NOT NULL AND w.ai_summary != '') >= 6
  ORDER BY RANDOM() LIMIT 1
`)

// 2. signal-mid: web 1~3
const midIds = d1Query<{ id: string }>(`
  SELECT p.id FROM parking_lots p
  WHERE (SELECT COUNT(*) FROM web_sources w WHERE w.parking_lot_id = p.id
         AND w.ai_summary IS NOT NULL AND w.ai_summary != '') BETWEEN 1 AND 3
    AND p.total_spaces > 0
  ORDER BY RANDOM() LIMIT 1
`)

// 3. meta-only: web=0, review=0, has hours+fee
const metaIds = d1Query<{ id: string }>(`
  SELECT p.id FROM parking_lots p
  WHERE NOT EXISTS (SELECT 1 FROM web_sources w WHERE w.parking_lot_id = p.id
                    AND w.ai_summary IS NOT NULL AND w.ai_summary != '')
    AND NOT EXISTS (SELECT 1 FROM user_reviews r WHERE r.parking_lot_id = p.id)
    AND p.weekday_start IS NOT NULL
    AND p.base_fee IS NOT NULL
  ORDER BY RANDOM() LIMIT 1
`)

// 4. meta-only worst: web=0, review=0, address only (no hours, no fee)
const worstIds = d1Query<{ id: string }>(`
  SELECT p.id FROM parking_lots p
  WHERE NOT EXISTS (SELECT 1 FROM web_sources w WHERE w.parking_lot_id = p.id
                    AND w.ai_summary IS NOT NULL AND w.ai_summary != '')
    AND NOT EXISTS (SELECT 1 FROM user_reviews r WHERE r.parking_lot_id = p.id)
    AND p.weekday_start IS NULL
    AND p.base_fee IS NULL
  ORDER BY RANDOM() LIMIT 1
`)

const tags = [
  'SIGNAL-RICH (web≥6)',
  'SIGNAL-MID (web 1-3)',
  'META-ONLY (hours+fee 보유)',
  'META-WORST (hours·fee 모두 null)',
]
const ids = [richIds[0]?.id, midIds[0]?.id, metaIds[0]?.id, worstIds[0]?.id]

for (let i = 0; i < ids.length; i++) {
  const id = ids[i]
  if (!id) {
    console.log(`\n=== ${tags[i]} ===`)
    console.log(`  (해당 카테고리 lot 없음)`)
    continue
  }
  const lot = fetchLot(id)
  if (!lot) continue
  const web = fetchWebSummaries(id)
  const reviews = fetchReviews(id)

  console.log(`\n=== ${tags[i]} ===`)
  console.log(`id: ${id}`)
  console.log(`name: ${lot.name}`)
  console.log(`address: ${lot.address}`)
  console.log(`type: ${lot.type}`)
  console.log(`total_spaces: ${lot.total_spaces ?? 'null'}`)
  console.log(`weekday: ${lot.weekday_start ?? 'null'} ~ ${lot.weekday_end ?? 'null'}`)
  console.log(`saturday: ${lot.saturday_start ?? 'null'} ~ ${lot.saturday_end ?? 'null'}`)
  console.log(`holiday: ${lot.holiday_start ?? 'null'} ~ ${lot.holiday_end ?? 'null'}`)
  console.log(`is_free: ${lot.is_free === 1}`)
  console.log(`base: ${lot.base_time ?? 'null'}분 / ${lot.base_fee ?? 'null'}원`)
  console.log(`extra: ${lot.extra_time ?? 'null'}분 / ${lot.extra_fee ?? 'null'}원`)
  console.log(`daily_max: ${lot.daily_max ?? 'null'}원`)
  console.log(`phone: ${lot.phone ?? 'null'}`)
  console.log(
    `is_curated: ${lot.is_curated === 1}, tag: ${lot.curation_tag ?? '-'}, reason: ${lot.curation_reason?.slice(0, 60) ?? '-'}`,
  )
  console.log(`final_score: ${lot.final_score?.toFixed(2) ?? 'null'}`)
  console.log(`web_summaries: ${web.length}건`)
  for (let j = 0; j < Math.min(web.length, 3); j++) {
    console.log(`  [W${j + 1}] ${web[j].slice(0, 200)}...`)
  }
  console.log(`reviews: ${reviews.length}건`)
  for (let j = 0; j < Math.min(reviews.length, 3); j++) {
    const r = reviews[j]
    console.log(
      `  [R${j + 1}] ${r.overall_score}/5 — ${r.comment?.slice(0, 100) ?? '(no comment)'}`,
    )
  }
}
