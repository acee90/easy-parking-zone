/**
 * D1 데이터베이스 공통 유틸리티
 *
 * 모든 스크립트에서 import해서 사용.
 * --remote 플래그가 있으면 리모트 D1에 직접 실행.
 *
 * Usage:
 *   import { d1Query, d1Execute, d1ExecFile, isRemote } from "./lib/d1";
 */
import { execSync } from "child_process";

const DB_NAME = "parking-db";

export const isRemote = process.argv.includes("--remote");

const target = isRemote ? "--remote" : "--local";

export function d1Query<T = Record<string, unknown>>(sql: string): T[] {
  const escaped = sql.replace(/"/g, '\\"');
  const raw = execSync(
    `npx wrangler d1 execute ${DB_NAME} ${target} --json --command "${escaped}"`,
    { encoding: "utf-8", maxBuffer: 100 * 1024 * 1024 }
  );
  return JSON.parse(raw)[0]?.results ?? [];
}

export function d1Execute(sql: string): void {
  const escaped = sql.replace(/"/g, '\\"');
  execSync(
    `npx wrangler d1 execute ${DB_NAME} ${target} --command "${escaped}"`,
    { stdio: "pipe" }
  );
}

export function d1ExecFile(filePath: string): void {
  execSync(
    `npx wrangler d1 execute ${DB_NAME} ${target} --file="${filePath}"`,
    { stdio: "pipe" }
  );
}
