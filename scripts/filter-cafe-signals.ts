/**
 * 카페 시그널 무관(irrelevant) 자동 필터링
 *
 * Claude Haiku로 title + snippet을 분석하여
 * 주차장 난이도/리뷰와 무관한 글(투자, 매물, 부동산 등)을 human_score = 0으로 마킹.
 *
 * 사용법:
 *   bun run scripts/filter-cafe-signals.ts --remote
 *   bun run scripts/filter-cafe-signals.ts --remote --dry-run   # DB 변경 없이 결과만 확인
 */
import Anthropic from "@anthropic-ai/sdk";
import { d1Query, d1Execute } from "./lib/d1";

const DRY_RUN = process.argv.includes("--dry-run");
const BATCH_SIZE = 50; // Haiku 한 번에 분류할 시그널 수
const CONCURRENCY = 5; // 동시 API 호출 수

interface Signal {
  id: number;
  title: string;
  snippet: string;
}

const client = new Anthropic();

const SYSTEM_PROMPT = `당신은 주차장 관련 커뮤니티 글을 분류하는 분류기입니다.

각 글의 제목과 스니펫을 보고, 해당 글이 "주차장 이용 경험/리뷰/난이도"에 관련된 글인지 판단하세요.

**무관(irrelevant)으로 분류할 글:**
- 부동산 매물/투자 소개 (예: "주차 가능", "주차 2대", "OO평 아파트")
- 상가/오피스텔/아파트 분양/매매 광고
- 단순 주소/위치 안내 (주차 경험 없이 장소만 언급)
- 맛집/카페/여행 후기에서 "주차 가능" 정도만 언급
- 자동차 매매/튜닝/보험 관련
- 주차장 건설/공사/정책 뉴스 (이용 경험 아님)

**관련(relevant)으로 분류할 글:**
- 주차장 실제 이용 후기 (좁다, 넓다, 복잡하다 등)
- 주차 난이도 언급 (초보 어렵다, 기계식, 타워형 등)
- 주차장 진입/출차 경험
- 특정 주차장에 대한 팁이나 주의사항

JSON 배열로 응답하세요. 각 항목은 {"id": number, "irrelevant": boolean} 형태입니다.
반드시 입력된 모든 id에 대해 응답하세요. JSON 외 다른 텍스트는 출력하지 마세요.`;

async function classifyBatch(signals: Signal[]): Promise<Map<number, boolean>> {
  const input = signals
    .map((s) => `[ID:${s.id}] 제목: ${s.title}\n스니펫: ${s.snippet}`)
    .join("\n---\n");

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: input }],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";

  // Haiku가 ```json ... ``` 로 감쌀 수 있으므로 코드블록 제거
  const jsonStr = text.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "").trim();

  const results = new Map<number, boolean>();
  try {
    const parsed: { id: number; irrelevant: boolean }[] = JSON.parse(jsonStr);
    for (const item of parsed) {
      results.set(item.id, item.irrelevant);
    }
  } catch (e) {
    console.error("  ⚠️ JSON 파싱 실패, 이 배치 스킵:", (e as Error).message);
    console.error("  응답:", jsonStr.slice(0, 200));
  }

  return results;
}

async function processConcurrent(
  batches: Signal[][],
  onResult: (irrelevantIds: number[]) => void
) {
  let idx = 0;

  async function worker() {
    while (idx < batches.length) {
      const batchIdx = idx++;
      const batch = batches[batchIdx];
      try {
        const results = await classifyBatch(batch);
        const irrelevantIds: number[] = [];
        for (const [id, isIrrelevant] of results) {
          if (isIrrelevant) irrelevantIds.push(id);
        }
        onResult(irrelevantIds);
      } catch (e) {
        console.error(
          `  ❌ 배치 ${batchIdx} API 에러:`,
          (e as Error).message
        );
      }
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);
}

async function main() {
  console.log("📋 미검수 카페 시그널 로드 중...");

  const signals = d1Query<Signal>(
    "SELECT id, title, snippet FROM cafe_signals WHERE human_score IS NULL ORDER BY id"
  );

  console.log(`  총 ${signals.length}건 미검수\n`);

  if (signals.length === 0) {
    console.log("✅ 처리할 시그널이 없습니다.");
    return;
  }

  // 배치 분할
  const batches: Signal[][] = [];
  for (let i = 0; i < signals.length; i += BATCH_SIZE) {
    batches.push(signals.slice(i, i + BATCH_SIZE));
  }
  console.log(
    `  ${batches.length}개 배치 (${BATCH_SIZE}건씩, 동시 ${CONCURRENCY}개)\n`
  );

  let totalIrrelevant = 0;
  let totalProcessed = 0;
  const allIrrelevantIds: number[] = [];

  await processConcurrent(batches, (irrelevantIds) => {
    totalProcessed += BATCH_SIZE;
    totalIrrelevant += irrelevantIds.length;
    allIrrelevantIds.push(...irrelevantIds);
    process.stdout.write(
      `\r  진행: ${Math.min(totalProcessed, signals.length)}/${signals.length}건 | 무관: ${totalIrrelevant}건`
    );
  });

  console.log(
    `\n\n📊 결과: ${allIrrelevantIds.length}건 무관 / ${signals.length}건 중`
  );

  if (DRY_RUN) {
    console.log("\n🔍 DRY RUN — DB 변경 없음");
    console.log(`  무관 ID 샘플 (처음 20개): ${allIrrelevantIds.slice(0, 20).join(", ")}`);
    return;
  }

  if (allIrrelevantIds.length === 0) {
    console.log("✅ 무관 시그널 없음.");
    return;
  }

  // 배치로 UPDATE
  console.log("\n💾 DB 업데이트 중...");
  const UPDATE_BATCH = 200;
  for (let i = 0; i < allIrrelevantIds.length; i += UPDATE_BATCH) {
    const chunk = allIrrelevantIds.slice(i, i + UPDATE_BATCH);
    const ids = chunk.join(",");
    d1Execute(
      `UPDATE cafe_signals SET human_score = 0, updated_at = datetime('now') WHERE id IN (${ids})`
    );
    process.stdout.write(
      `\r  ${Math.min(i + UPDATE_BATCH, allIrrelevantIds.length)}/${allIrrelevantIds.length}건 업데이트됨`
    );
  }

  console.log(`\n\n✅ 완료! ${allIrrelevantIds.length}건 무관 처리됨`);
}

main().catch((err) => {
  console.error("에러:", err.message);
  process.exit(1);
});
