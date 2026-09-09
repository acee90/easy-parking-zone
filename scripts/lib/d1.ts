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

import { Database } from 'bun:sqlite'
import { execSync } from 'child_process'
import { readdirSync } from 'fs'
import { resolve } from 'path'

const DB_NAME = 'parking-db'

export const isRemote = process.argv.includes('--remote')

// --db PATH: 로컬 SQLite 파일 직접 지정 (remote 대신 사용)
const _dbArgIdx = process.argv.indexOf('--db')
export const localDbPath: string | null =
  _dbArgIdx >= 0 ? (process.argv[_dbArgIdx + 1] ?? null) : null

const target = isRemote ? '--remote' : '--local'

// 로컬 SQLite DB 인스턴스 (lazy init)
let _localDb: InstanceType<typeof Database> | null = null

function getLocalDb(): InstanceType<typeof Database> {
  if (_localDb) return _localDb

  // --db PATH 플래그로 직접 지정된 파일 사용
  if (localDbPath) {
    _localDb = new Database(localDbPath)
    return _localDb
  }

  const stateDir = resolve(import.meta.dir, '../../.wrangler/state/v3/d1')
  const subDirs = readdirSync(stateDir)

  for (const dir of subDirs) {
    const fullPath = resolve(stateDir, dir)
    try {
      const files = readdirSync(fullPath).filter(
        (f) => f.endsWith('.sqlite') && !f.includes('metadata'),
      )
      if (files.length > 0) {
        console.log(`로컬 DB 발견: ${fullPath}/${files[0]}`)
        _localDb = new Database(resolve(fullPath, files[0]))
        return _localDb
      }
    } catch (e) {}
  }

  throw new Error(
    '로컬 D1 SQLite 파일을 찾을 수 없습니다. --db PATH 또는 wrangler dev를 먼저 실행하세요.',
  )
}

function escapeForShell(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().replace(/"/g, '\\"')
}

// ── D1 REST 프록시 ──
// wrangler CLI 로그인이 없는 환경(예: 에이전트 세션)에서 --remote 를 쓰기 위한 경로.
// --proxy 를 명시했을 때만 켜진다 — wrangler 가 인증된 환경의 기존 동작은 그대로 둔다.
// d1Query/d1Execute 가 동기 API라 fetch 를 못 쓴다. curl 을 execSync 로 부른다.
const useProxy = process.argv.includes('--proxy')
const CF_ACCOUNT_ID = '434357ee2e3363aea69437f67e2053ef'
const CF_DATABASE_ID = 'ff5d77af-8ca6-4e5c-acf2-2fdf765dd248'

function proxyToken(): string {
  const token = process.env.D1_PROXY_TOKEN
  if (!token) throw new Error('--proxy 를 쓰려면 D1_PROXY_TOKEN 환경변수가 필요합니다 (.env)')
  return token
}

/** SQL 한 덩어리를 D1 REST /query 로 보내고 첫 문장의 결과를 돌려준다 */
function proxyRun<T>(sql: string): T[] {
  const { writeFileSync, unlinkSync, mkdtempSync } = require('fs')
  const { join } = require('path')
  const { tmpdir } = require('os')
  const dir = mkdtempSync(join(tmpdir(), 'd1-'))
  const bodyPath = join(dir, 'body.json')
  writeFileSync(bodyPath, JSON.stringify({ sql }))
  try {
    const raw = execSync(
      `curl -sS -X POST "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${CF_DATABASE_ID}/query" ` +
        `-H "Authorization: Bearer ${proxyToken()}" -H "Content-Type: application/json" --data-binary @${bodyPath}`,
      { encoding: 'utf-8', maxBuffer: 200 * 1024 * 1024 },
    )
    const json = JSON.parse(raw)
    if (!json.success) throw new Error(`D1 프록시 오류: ${JSON.stringify(json.errors)}`)
    return (json.result?.[0]?.results ?? []) as T[]
  } finally {
    try {
      unlinkSync(bodyPath)
    } catch {}
  }
}

export function d1Query<T = Record<string, unknown>>(sql: string): T[] {
  if (!isRemote) {
    return getLocalDb().query(sql).all() as T[]
  }
  if (useProxy) return proxyRun<T>(sql)
  const escaped = escapeForShell(sql)
  const raw = execSync(
    `bunx wrangler d1 execute ${DB_NAME} ${target} --json --command "${escaped}"`,
    { encoding: 'utf-8', maxBuffer: 100 * 1024 * 1024 },
  )
  return JSON.parse(raw)[0]?.results ?? []
}

export function d1Execute(sql: string): void {
  if (!isRemote) {
    getLocalDb().run(sql)
    return
  }
  if (useProxy) {
    proxyRun(sql)
    return
  }
  const escaped = escapeForShell(sql)
  execSync(`bunx wrangler d1 execute ${DB_NAME} ${target} --command "${escaped}"`, {
    stdio: 'pipe',
  })
}

export function d1ExecFile(filePath: string): void {
  if (!isRemote) {
    const content = require('fs').readFileSync(filePath, 'utf-8')
    getLocalDb().exec(content)
    return
  }
  if (useProxy) {
    // REST /query 는 큰 본문을 거부하므로 문장 단위로 잘라 보낸다
    const content: string = require('fs').readFileSync(filePath, 'utf-8')
    const stmts = content
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('--'))
    for (let i = 0; i < stmts.length; i += 50) proxyRun(stmts.slice(i, i + 50).join('\n'))
    return
  }
  execSync(`bunx wrangler d1 execute ${DB_NAME} ${target} --file="${filePath}"`, { stdio: 'pipe' })
}
