/**
 * 카페 시그널 JSON → D1 cafe_signals 테이블 임포트
 *
 * 로컬: bun:sqlite로 직접 SQLite 파일에 삽입 (초고속)
 * 리모트: wrangler d1 execute --remote (배치)
 *
 * 사용법:
 *   bun run scripts/import-cafe-signals.ts           # 로컬 D1
 *   bun run scripts/import-cafe-signals.ts --remote   # 리모트 D1
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { Database } from "bun:sqlite";
import { isRemote } from "./lib/d1";
import { esc, flushStatements } from "./lib/sql-flush";
import { readdirSync } from "fs";

const SIGNALS_FILE = resolve(import.meta.dir, "cafe-signals.json");
const TMP_SQL = resolve(import.meta.dir, "../.tmp-cafe-signals.sql");
const D1_DIR = resolve(import.meta.dir, "../.wrangler/state/v3/d1");

interface CafeSignal {
  parkingLotId: string;
  lotName: string;
  address: string;
  url: string;
  title: string;
  snippet: string;
  aiSentiment: string;
}

function findLocalDb(): string {
  try {
    for (const dir of readdirSync(D1_DIR, { recursive: true, withFileTypes: true })) {
      if (dir.name.endsWith(".sqlite")) {
        return resolve(dir.parentPath, dir.name);
      }
    }
  } catch {}
  throw new Error("로컬 D1 SQLite 파일을 찾을 수 없습니다. wrangler dev를 먼저 실행하세요.");
}

function importLocal(signals: CafeSignal[]) {
  const dbPath = findLocalDb();
  console.log(`SQLite 직접 접근: ${dbPath}\n`);

  const db = new Database(dbPath);
  db.run("DELETE FROM cafe_signals");

  const insert = db.prepare(
    `INSERT OR IGNORE INTO cafe_signals (parking_lot_id, url, title, snippet, ai_sentiment, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  );

  const batchInsert = db.transaction((batch: CafeSignal[]) => {
    for (const s of batch) {
      insert.run(s.parkingLotId, s.url, s.title, s.snippet, s.aiSentiment);
    }
  });

  const BATCH = 5000;
  let imported = 0;

  for (let i = 0; i < signals.length; i += BATCH) {
    const batch = signals.slice(i, i + BATCH);
    batchInsert(batch);
    imported += batch.length;
    process.stdout.write(`\r  ${imported}/${signals.length}건 임포트됨`);
  }

  db.close();
  console.log(`\n\n✅ 완료! ${imported}건 임포트됨`);
}

function importRemote(signals: CafeSignal[]) {
  console.log("🌐 리모트 D1 모드\n");
  flushStatements(TMP_SQL, ["DELETE FROM cafe_signals;"]);

  const BATCH = 500;
  let imported = 0;

  for (let i = 0; i < signals.length; i += BATCH) {
    const batch = signals.slice(i, i + BATCH);
    const statements = batch.map(
      (s) =>
        `INSERT OR IGNORE INTO cafe_signals (parking_lot_id, url, title, snippet, ai_sentiment, created_at, updated_at) VALUES ('${esc(s.parkingLotId)}', '${esc(s.url)}', '${esc(s.title)}', '${esc(s.snippet)}', '${esc(s.aiSentiment)}', datetime('now'), datetime('now'));`
    );
    flushStatements(TMP_SQL, statements);
    imported += batch.length;
    process.stdout.write(`\r  ${imported}/${signals.length}건 임포트됨`);
  }

  console.log(`\n\n✅ 완료! ${imported}건 임포트됨`);
}

async function main() {
  console.log("시그널 파일 로드 중...");
  const signals: CafeSignal[] = JSON.parse(readFileSync(SIGNALS_FILE, "utf-8"));
  console.log(`총 ${signals.length}건`);

  if (isRemote) {
    importRemote(signals);
  } else {
    importLocal(signals);
  }
}

main().catch((err) => {
  console.error("에러:", err.message);
  process.exit(1);
});
