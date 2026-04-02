import type { ParkingFilters } from '@/types/parking'

/** 난이도 필터 SQL 조건 생성 */
export function buildDifficultyCondition(
  filters?: ParkingFilters,
  scoreCol = 's.final_score',
): string {
  if (!filters?.difficulty) return ''
  const d = filters.difficulty
  const allOn = d.easy && d.decent && d.normal && d.bad && d.hard && d.hell
  if (allOn) return ''

  const conditions: string[] = []
  if (d.easy) conditions.push(`(${scoreCol} >= 4.0)`)
  if (d.decent) conditions.push(`(${scoreCol} >= 3.3 AND ${scoreCol} < 4.0)`)
  if (d.normal) conditions.push(`(${scoreCol} >= 2.7 AND ${scoreCol} < 3.3)`)
  if (d.bad) conditions.push(`(${scoreCol} >= 2.0 AND ${scoreCol} < 2.7)`)
  if (d.hard) conditions.push(`(${scoreCol} >= 1.5 AND ${scoreCol} < 2.0)`)
  if (d.hell) conditions.push(`(${scoreCol} >= 1.0 AND ${scoreCol} < 1.5)`)

  return conditions.length > 0 ? `(${conditions.join(' OR ')})` : '0'
}
