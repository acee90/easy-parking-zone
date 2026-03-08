/**
 * JSON 파일 기반 진행 상태 관리
 *
 * 모든 크롤링 스크립트에서 공통 사용.
 * 중단 후 재개를 위한 load/save 패턴.
 */
import { writeFileSync, readFileSync, existsSync } from "fs";

export function loadProgress<T extends Record<string, unknown>>(
  filePath: string,
  defaults: T
): T {
  if (existsSync(filePath)) {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  }
  return { ...defaults, startedAt: new Date().toISOString(), lastUpdatedAt: new Date().toISOString() };
}

export function saveProgress<T extends Record<string, unknown>>(
  filePath: string,
  data: T
): void {
  (data as Record<string, unknown>).lastUpdatedAt = new Date().toISOString();
  writeFileSync(filePath, JSON.stringify(data, null, 2));
}
