/**
 * Stage 1: 광고/무관 콘텐츠 분류 — Haiku로 web_sources.is_ad 마킹
 *
 * web_sources 전체를 배치로 Haiku에 보내서 광고 여부 판별 후 DB 업데이트.
 * 진행상황 저장 → 중단 후 재개 가능.
 *
 * Usage:
 *   bun scripts/classify-ads.ts --remote
 *   bun scripts/classify-ads.ts --remote --dry-run
 */
import { d1Query, d1Execute, isRemote } from "./lib/d1";
import { loadProgress, saveProgress } from "./lib/progress";
import { sleep } from "./lib/geo";
import { resolve } from "path";
import { writeFileSync } from "fs";

const isDryRun = process.argv.includes("--dry-run");
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY가 .env에 설정되지 않았습니다.");
  process.exit(1);
}

const BATCH_SIZE = 30; // Haiku 1회 호출당 건수
const DB_BATCH = 200;  // DB 업데이트 배치
const PROGRESS_JSON = resolve(import.meta.dir, "classify-ads-progress.json");

interface Row {
  id: number;
  title: string;
  content: string;
  source: string;
}

interface Progress {
  lastProcessedId: number;
  totalProcessed: number;
  totalAds: number;
  totalClean: number;
  errors: number;
  startedAt: string;
  lastUpdatedAt: string;
}

async function classifyBatch(items: Row[]): Promise<Map<number, boolean>> {
  const entries = items
    .map(
      (r, i) =>
        `[${i}] title: ${r.title.slice(0, 100)}\nsnippet: ${r.content.slice(0, 200)}`
    )
    .join("\n\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 512,
      messages: [
        {
          role: "user",
          content: `아래 텍스트들이 "주차장 이용과 관련된 실제 콘텐츠"인지 판별해줘.

광고/무관(1)으로 분류할 것:
- 부동산 분양, 모델하우스, 매매, 임대, 경매 광고
- 상업 홍보 (체험단, 업체 광고, 맛집/카페 홍보)
- 주차장과 무관한 콘텐츠 (뉴스, 사건, 공연, 예산)
- 아파트/오피스텔 분양 정보에서 "주차 N대" 같은 사양 나열

주차 관련(0)으로 분류할 것:
- 주차장 이용 후기, 주차 팁, 주차 난이도 언급
- 주차장 운영/개방 안내
- 주차 경험 (좁다, 넓다, 편하다, 힘들다)

각 항목: 번호:판정 (예: 0:1,1:0,2:0,...)

${entries}`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Haiku API ${res.status}: ${err}`);
  }

  const data = (await res.json()) as { content: Array<{ text: string }> };
  const text = data.content[0].text;

  const result = new Map<number, boolean>();
  for (const m of text.matchAll(/(\d+)\s*:\s*([01])/g)) {
    const idx = parseInt(m[1]);
    if (idx < items.length) {
      result.set(items[idx].id, m[2] === "1");
    }
  }
  return result;
}

async function main() {
  console.log(
    `[분류] ${isRemote ? "REMOTE" : "LOCAL"} D1 | ${isDryRun ? "DRY-RUN" : "LIVE"}`
  );

  const progress = loadProgress<Progress>(PROGRESS_JSON, {
    lastProcessedId: 0,
    totalProcessed: 0,
    totalAds: 0,
    totalClean: 0,
    errors: 0,
    startedAt: "",
    lastUpdatedAt: "",
  });

  // 전체 건수
  const [{ cnt: totalRows }] = d1Query<{ cnt: number }>(
    "SELECT COUNT(*) as cnt FROM web_sources"
  );
  const [{ cnt: remaining }] = d1Query<{ cnt: number }>(
    `SELECT COUNT(*) as cnt FROM web_sources WHERE id > ${progress.lastProcessedId}`
  );
  console.log(
    `[분류] 전체 ${totalRows}건, 남은 ${remaining}건 (이전 완료: ${progress.totalProcessed}건)`
  );

  // 결과 버퍼 (dry-run용)
  const dryResults: Array<{ id: number; isAd: boolean }> = [];
  // DB 업데이트 버퍼
  let pendingUpdates: Array<{ id: number; isAd: boolean }> = [];

  function flushUpdates() {
    if (pendingUpdates.length === 0) return;
    if (isDryRun) {
      dryResults.push(...pendingUpdates);
      pendingUpdates = [];
      return;
    }
    // 배치 UPDATE
    const adIds = pendingUpdates.filter((u) => u.isAd).map((u) => u.id);
    if (adIds.length > 0) {
      d1Execute(
        `UPDATE web_sources SET is_ad = 1 WHERE id IN (${adIds.join(",")})`
      );
    }
    pendingUpdates = [];
  }

  let cursor = progress.lastProcessedId;

  while (true) {
    const rows = d1Query<Row>(
      `SELECT id, title, content, source FROM web_sources WHERE id > ${cursor} ORDER BY id LIMIT ${BATCH_SIZE}`
    );
    if (rows.length === 0) break;

    try {
      const results = await classifyBatch(rows);

      for (const row of rows) {
        const isAd = results.get(row.id) ?? false;
        pendingUpdates.push({ id: row.id, isAd });
        if (isAd) progress.totalAds++;
        else progress.totalClean++;
        progress.totalProcessed++;
      }

      cursor = rows[rows.length - 1].id;
      progress.lastProcessedId = cursor;

      if (pendingUpdates.length >= DB_BATCH) {
        flushUpdates();
      }
    } catch (err) {
      console.error(`\n  분류 오류: ${(err as Error).message}`);
      progress.errors++;
      // 실패 시 해당 배치 스킵하고 다음으로
      cursor = rows[rows.length - 1].id;
      progress.lastProcessedId = cursor;
      await sleep(2000);
    }

    if (progress.totalProcessed % 300 === 0) {
      saveProgress(PROGRESS_JSON, progress);
      process.stdout.write(
        `\r  ${progress.totalProcessed}/${totalRows} | 광고 ${progress.totalAds} | 정상 ${progress.totalClean} | 오류 ${progress.errors}`
      );
    }

    await sleep(100); // rate limit
  }

  // 잔여 flush
  flushUpdates();
  saveProgress(PROGRESS_JSON, progress);

  console.log(`\n\n[분류] === 완료 ===`);
  console.log(`  처리: ${progress.totalProcessed}건`);
  console.log(`  광고: ${progress.totalAds}건 (${((progress.totalAds / progress.totalProcessed) * 100).toFixed(1)}%)`);
  console.log(`  정상: ${progress.totalClean}건`);
  console.log(`  오류: ${progress.errors}건`);

  if (isDryRun) {
    const outPath = resolve(import.meta.dir, "classify-ads-results.json");
    writeFileSync(outPath, JSON.stringify(dryResults, null, 2));
    console.log(`  결과 파일: ${outPath}`);
  }
}

main().catch(console.error);
