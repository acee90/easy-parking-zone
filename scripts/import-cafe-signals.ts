/**
 * 카페 시그널 JSON → D1 cafe_signals 테이블 임포트
 *
 * 사용법:
 *   bun run scripts/import-cafe-signals.ts           # 로컬 D1
 *   bun run scripts/import-cafe-signals.ts --remote   # 리모트 D1
 */
import { readFileSync, writeFileSync, unlinkSync } from "fs";
import { resolve } from "path";
import { d1Query, d1Execute, d1ExecFile, isRemote } from "./lib/d1";
import { esc } from "./lib/sql-flush";

const SIGNALS_FILE = resolve(import.meta.dir, "cafe-signals.json");
const TMP_SQL = resolve(import.meta.dir, "../.tmp-cafe-signals.sql");

interface CafeSignal {
  parkingLotId: string;
  lotName: string;
  address: string;
  url: string;
  title: string;
  snippet: string;
  aiSentiment: string;
}

async function main() {
  if (isRemote) console.log("🌐 리모트 D1 모드\n");

  console.log("시그널 파일 로드 중...");
  const signals: CafeSignal[] = JSON.parse(readFileSync(SIGNALS_FILE, "utf-8"));
  console.log(`총 ${signals.length}건\n`);

  // 기존 데이터 확인
  const existing = d1Query<{ cnt: number }>(
    "SELECT COUNT(*) as cnt FROM cafe_signals"
  );
  if (existing[0]?.cnt > 0) {
    console.log(`기존 데이터 ${existing[0].cnt}건 삭제 중...`);
    d1Execute("DELETE FROM cafe_signals;");
  }

  // 덤프 INSERT (단일 파일 실행)
  console.log("SQL 덤프 파일 생성 중...");
  const statements: string[] = [];

  for (const s of signals) {
    statements.push(
      `INSERT OR IGNORE INTO cafe_signals (parking_lot_id, url, title, snippet, ai_sentiment, created_at, updated_at) VALUES ('${esc(s.parkingLotId)}', '${esc(s.url)}', '${esc(s.title)}', '${esc(s.snippet)}', '${esc(s.aiSentiment)}', datetime('now'), datetime('now'));`
    );
  }

  console.log(`SQL 실행 중 (${statements.length}건)... 잠시만 기다려 주세요.`);
  writeFileSync(TMP_SQL, statements.join("\n"));

  try {
    d1ExecFile(TMP_SQL);
    console.log(`\n✅ 완료! ${statements.length}건 임포트됨`);
  } catch (err: any) {
    console.error("\n❌ SQL 실행 실패. 파일이 너무 클 수 있습니다.");
    console.error(err.message);
    throw err;
  } finally {
    unlinkSync(TMP_SQL);
  }
}

main().catch((err) => {
  console.error("에러:", err.message);
  process.exit(1);
});
