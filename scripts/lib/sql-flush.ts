/**
 * SQL INSERT 생성 + 배치 flush 유틸
 *
 * 모든 크롤링 스크립트에서 공통 사용.
 * INSERT OR IGNORE 문 생성 → tmp 파일 기록 → d1ExecFile → 삭제.
 */
import { writeFileSync, unlinkSync } from "fs";
import { d1ExecFile } from "./d1";

/** SQL 문자열 이스케이프 (싱글쿼트) */
export function esc(s: string): string {
  return s.replace(/'/g, "''");
}

/** SQL 값 포맷: 문자열은 escape+quote, null은 NULL, 숫자는 그대로 */
export function sqlVal(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  return `'${esc(v)}'`;
}

/** INSERT OR IGNORE 문 생성 */
export function buildInsert(
  table: string,
  columns: string[],
  values: (string | number | null | undefined)[]
): string {
  const vals = values.map(sqlVal).join(", ");
  return `INSERT OR IGNORE INTO ${table} (${columns.join(", ")}) VALUES (${vals});`;
}

/** SQL 문 배열을 tmp 파일로 flush 후 D1 실행 + 삭제 */
export function flushStatements(tmpPath: string, statements: string[]): void {
  if (statements.length === 0) return;
  // 트랜잭션으로 감싸서 lock 최소화 + 성능 향상
  const CHUNK = 100;
  for (let i = 0; i < statements.length; i += CHUNK) {
    const chunk = statements.slice(i, i + CHUNK);
    const sql = "BEGIN;\n" + chunk.join("\n") + "\nCOMMIT;";
    writeFileSync(tmpPath, sql);
    d1ExecFile(tmpPath);
    unlinkSync(tmpPath);
  }
}
