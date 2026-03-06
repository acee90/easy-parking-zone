/**
 * AI 기반 리뷰 요약 백필 스크립트
 *
 * Claude Haiku로 crawled_reviews의 리뷰를 분석하여:
 * 1) 실제 주차 경험 후기인지 판별
 * 2) 맞으면 1-2문장 요약 + 긍부정 판단
 *
 * - 배치: 20건씩 묶어서 1회 API 호출
 * - 동시성: 5개 동시 API 호출
 * - 중단/재개: WHERE summary IS NULL
 * - 리셋: --reset 플래그로 기존 summary 전체 NULL 처리
 *
 * 사용법:
 *   bun run backfill-summaries          # 미처리분만 처리
 *   bun run backfill-summaries --reset  # 전체 리셋 후 재처리
 */
import Anthropic from "@anthropic-ai/sdk";
import { writeFileSync, existsSync, unlinkSync } from "fs";
import { execSync } from "child_process";
import { resolve } from "path";

const API_BATCH_SIZE = 20; // 1회 API 호출당 리뷰 수
const CONCURRENCY = 5; // 동시 API 호출 수
const DB_BATCH_SIZE = 100; // DB UPDATE 배치 크기
const TMP_SQL = resolve(import.meta.dir, "../.tmp-backfill.sql");

const client = new Anthropic();

const SYSTEM_PROMPT = `주차장 블로그/카페 리뷰를 분석해주세요.
각 리뷰가 "실제 주차장 이용 경험"인지 판별하고, 맞다면 주차 관련 내용을 1-2문장으로 요약해주세요.

판별 기준:
- 포함: 직접 주차한 경험, 주차장 시설 평가, 주차 난이도, 진출입 후기
- 제외: 도시개발/재건축 뉴스, 부동산 매물 소개, 행사/이벤트 안내, 주차장 위치만 언급하고 실제 이용 경험 없는 글

반드시 JSON 배열만 응답하세요. 다른 텍스트 없이 JSON만:
[{"id": 1, "relevant": true, "summary": "요약문", "positive": true}, ...]
- relevant=false면 summary와 positive는 null`;

interface ReviewRow {
  id: number;
  title: string;
  content: string;
}

interface AiResult {
  id: number;
  relevant: boolean;
  summary: string | null;
  positive: boolean | null;
}

function esc(s: string): string {
  return s.replace(/'/g, "''");
}

async function callHaiku(batch: ReviewRow[]): Promise<AiResult[]> {
  const userContent = batch
    .map(
      (r) =>
        `[ID: ${r.id}]\n제목: ${r.title}\n내용: ${r.content.slice(0, 500)}`
    )
    .join("\n\n---\n\n");

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userContent }],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";

  // JSON 배열 파싱 (코드블록 감싸기 대응)
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    console.error(`\nJSON 파싱 실패, 배치 건너뜀 (IDs: ${batch.map((r) => r.id).join(",")})`);
    return batch.map((r) => ({
      id: r.id,
      relevant: false,
      summary: null,
      positive: null,
    }));
  }

  return JSON.parse(jsonMatch[0]);
}

async function processConcurrent(
  batches: ReviewRow[][],
  onBatchDone: (results: AiResult[]) => void
) {
  let idx = 0;

  async function worker() {
    while (idx < batches.length) {
      const batchIdx = idx++;
      const results = await callHaiku(batches[batchIdx]);
      onBatchDone(results);
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, batches.length) }, () => worker());
  await Promise.all(workers);
}

async function main() {
  const isReset = process.argv.includes("--reset");

  if (isReset) {
    console.log("기존 summary 전체 리셋 중...");
    execSync(
      `npx wrangler d1 execute parking-db --local --command "UPDATE crawled_reviews SET summary = NULL, is_positive = NULL"`,
      { stdio: "pipe" }
    );
    console.log("리셋 완료.");
  }

  console.log("미처리 리뷰 조회 중...");
  const json = execSync(
    `npx wrangler d1 execute parking-db --local --command "SELECT id, title, content FROM crawled_reviews WHERE summary IS NULL" --json`,
    { encoding: "utf-8", maxBuffer: 100 * 1024 * 1024 }
  );
  const parsed = JSON.parse(json);
  const rows: ReviewRow[] = parsed[0]?.results ?? [];

  console.log(`미처리 리뷰 ${rows.length}건 발견`);
  if (rows.length === 0) {
    console.log("처리할 리뷰가 없습니다.");
    return;
  }

  // API 배치 분할
  const batches: ReviewRow[][] = [];
  for (let i = 0; i < rows.length; i += API_BATCH_SIZE) {
    batches.push(rows.slice(i, i + API_BATCH_SIZE));
  }
  console.log(`${batches.length}개 배치 (${API_BATCH_SIZE}건/배치, 동시성 ${CONCURRENCY})`);

  let processed = 0;
  let summarized = 0;
  let irrelevant = 0;
  let sqlBuffer: string[] = [];

  function flushSql() {
    if (sqlBuffer.length === 0) return;
    writeFileSync(TMP_SQL, sqlBuffer.join("\n"));
    execSync(
      `npx wrangler d1 execute parking-db --local --file="${TMP_SQL}"`,
      { stdio: "pipe" }
    );
    sqlBuffer = [];
  }

  await processConcurrent(batches, (results) => {
    for (const r of results) {
      if (r.relevant && r.summary) {
        sqlBuffer.push(
          `UPDATE crawled_reviews SET summary = '${esc(r.summary)}', is_positive = ${r.positive ? 1 : 0} WHERE id = ${r.id};`
        );
        summarized++;
      } else {
        sqlBuffer.push(
          `UPDATE crawled_reviews SET summary = '', is_positive = NULL WHERE id = ${r.id};`
        );
        irrelevant++;
      }
      processed++;
    }

    if (sqlBuffer.length >= DB_BATCH_SIZE) {
      flushSql();
    }

    process.stdout.write(
      `\r  ${processed}/${rows.length} | 요약 ${summarized}건 | 무관 ${irrelevant}건`
    );
  });

  // 나머지 flush
  flushSql();

  if (existsSync(TMP_SQL)) unlinkSync(TMP_SQL);

  console.log(
    `\n\n완료! 총 ${processed}건 처리 | 요약 ${summarized}건 | 무관 ${irrelevant}건`
  );
}

main().catch((err) => {
  console.error("\n에러:", err.message);
  process.exit(1);
});
