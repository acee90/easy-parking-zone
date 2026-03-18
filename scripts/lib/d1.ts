/**
 * D1 데이터베이스 공통 유틸리티
 *
 * 모든 스크립트에서 import해서 사용.
 * --remote 플래그가 있으면 리모트 D1에 wrangler CLI로 실행.
 * 로컬은 bun:sqlite로 직접 접근 (프로세스 스폰 없이 고속).
 *
 * Usage:
 *   import { d1Query, d1Execute, d1ExecFile, isRemote } from "./lib/d1";
 */
import { execSync } from "child_process";
import { Database } from "bun:sqlite";
import { resolve } from "path";
import { readdirSync } from "fs";

const DB_NAME = "parking-db";

export const isRemote = process.argv.includes("--remote");

const target = isRemote ? "--remote" : "--local";

// 로컬 SQLite DB 인스턴스 (lazy init)
let _localDb: InstanceType<typeof Database> | null = null;

function getLocalDb(): InstanceType<typeof Database> {
  if (_localDb) return _localDb;
  const d1Dir = resolve(import.meta.dir, "../../.wrangler/state/v3/d1/miniflare-D1DatabaseObject");
  const files = readdirSync(d1Dir).filter((f) => f.endsWith(".sqlite"));
  if (files.length === 0) throw new Error("로컬 D1 SQLite 파일을 찾을 수 없습니다. wrangler dev를 먼저 실행하세요.");
  _localDb = new Database(resolve(d1Dir, files[0]));
  return _localDb;
}

export function d1Query<T = Record<string, unknown>>(sql: string): T[] {
  if (!isRemote) {
    return getLocalDb().query(sql).all() as T[];
  }
  const escaped = sql.replace(/"/g, '\\"');
  const raw = execSync(
    `npx wrangler d1 execute ${DB_NAME} ${target} --json --command "${escaped}"`,
    { encoding: "utf-8", maxBuffer: 100 * 1024 * 1024 }
  );
  return JSON.parse(raw)[0]?.results ?? [];
}

export function d1Execute(sql: string): void {
  if (!isRemote) {
    getLocalDb().run(sql);
    return;
  }
  const escaped = sql.replace(/"/g, '\\"');
  execSync(
    `npx wrangler d1 execute ${DB_NAME} ${target} --command "${escaped}"`,
    { stdio: "pipe" }
  );
}

export function d1ExecFile(filePath: string): void {
  if (!isRemote) {
    const content = require("fs").readFileSync(filePath, "utf-8");
    getLocalDb().exec(content);
    return;
  }
  execSync(
    `npx wrangler d1 execute ${DB_NAME} ${target} --file="${filePath}"`,
    { stdio: "pipe" }
  );
}
