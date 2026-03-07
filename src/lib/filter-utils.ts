import type { ParkingFilters } from "@/types/parking";

/** 난이도 필터 SQL 조건 생성 */
export function buildDifficultyCondition(filters?: ParkingFilters, scoreCol = "avg_score"): string {
  if (!filters?.difficulty) return "";
  const d = filters.difficulty;
  const allOn = d.easy && d.normal && d.hard && d.hell && d.noReview;
  if (allOn) return "";

  const conditions: string[] = [];
  if (d.easy) conditions.push(`(${scoreCol} >= 4.0)`);
  if (d.normal) conditions.push(`(${scoreCol} >= 2.5 AND ${scoreCol} < 4.0)`);
  if (d.hard) conditions.push(`(${scoreCol} >= 1.5 AND ${scoreCol} < 2.5)`);
  if (d.hell) conditions.push(`(${scoreCol} >= 1.0 AND ${scoreCol} < 1.5)`);
  if (d.noReview) conditions.push(`(${scoreCol} IS NULL)`);

  return conditions.length > 0 ? `(${conditions.join(" OR ")})` : "0";
}
