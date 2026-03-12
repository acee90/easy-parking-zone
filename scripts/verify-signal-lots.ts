/**
 * 카페 시그널 ↔ 주차장 연결 검증
 *
 * Claude Haiku로 title + snippet + 연결된 주차장 목록을 분석하여
 * 잘못 매칭된 주차장 링크를 제거.
 *
 * 사용법:
 *   bun run scripts/verify-signal-lots.ts --remote
 */
import Anthropic from "@anthropic-ai/sdk";
import { resolve } from "path";
import { writeFileSync, unlinkSync } from "fs";
import { d1Query } from "./lib/d1";
import { d1ExecFile } from "./lib/d1";

const BATCH_SIZE = 20; // 시그널 수 (주차장 목록 포함이라 작게)
const CONCURRENCY = 5;

interface SignalWithLots {
  id: number;
  title: string;
  snippet: string;
  lots: { parking_lot_id: string; name: string; address: string }[];
}

const client = new Anthropic();

const SYSTEM_PROMPT = `당신은 카페 커뮤니티 글과 주차장 매칭을 검증하는 분류기입니다.

각 글의 제목, 스니펫, 그리고 현재 연결된 주차장 목록이 주어집니다.
글의 내용(지역, 장소명, 맥락)을 보고, 실제로 그 글이 언급하는 주차장만 골라주세요.

**판단 기준:**
- 글에서 언급하는 지역/동네와 주차장 주소의 지역이 일치하는가?
- 글에서 언급하는 장소명과 주차장 이름이 관련 있는가?
- 키워드만 겹치고 실제로는 다른 지역/장소인 경우 제거 (예: "강남구" 글에 "울산 남구청" 주차장)

**응답 형식:**
JSON 배열로 응답. 각 항목은 {"signal_id": number, "keep": ["lot_id1", ...]} 형태.
keep 배열에는 유지할 주차장 ID만 포함. 모두 무관하면 빈 배열 [].
JSON 외 다른 텍스트는 출력하지 마세요.`;

async function classifyBatch(
  signals: SignalWithLots[]
): Promise<Map<number, string[]>> {
  const input = signals
    .map((s) => {
      const lotList = s.lots
        .map((l) => `  - [${l.parking_lot_id}] ${l.name} (${l.address})`)
        .join("\n");
      return `[Signal:${s.id}] 제목: ${s.title}\n스니펫: ${s.snippet}\n연결된 주차장:\n${lotList}`;
    })
    .join("\n===\n");

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: input }],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";
  const jsonStr = text
    .replace(/^```(?:json)?\s*\n?/m, "")
    .replace(/\n?```\s*$/m, "")
    .trim();

  const results = new Map<number, string[]>();
  try {
    const parsed: { signal_id: number; keep: string[] }[] =
      JSON.parse(jsonStr);
    for (const item of parsed) {
      results.set(item.signal_id, item.keep);
    }
  } catch (e) {
    console.error(
      "\n  ⚠️ JSON 파싱 실패, 이 배치 스킵:",
      (e as Error).message
    );
    console.error("  응답:", jsonStr.slice(0, 300));
  }

  return results;
}

function paginatedQuery<T>(baseSql: string, pageSize = 2000): T[] {
  const all: T[] = [];
  let offset = 0;
  while (true) {
    const rows = d1Query<T>(`${baseSql} LIMIT ${pageSize} OFFSET ${offset}`);
    all.push(...rows);
    if (rows.length < pageSize) break;
    offset += pageSize;
    process.stdout.write(`\r  로드 중... ${all.length}건`);
  }
  return all;
}

async function main() {
  console.log("📋 미검수 시그널 + 주차장 링크 로드 중...");

  const signalRows = paginatedQuery<{ id: number; title: string; snippet: string }>(
    `SELECT DISTINCT cs.id, cs.title, cs.snippet
     FROM cafe_signals cs
     JOIN cafe_signal_lots csl ON csl.signal_id = cs.id
     WHERE cs.human_score IS NULL
     ORDER BY cs.id`
  );

  console.log(`\n  시그널 ${signalRows.length}건`);

  if (signalRows.length === 0) {
    console.log("✅ 처리할 시그널이 없습니다.");
    return;
  }

  const lotRows = paginatedQuery<{
    signal_id: number;
    parking_lot_id: string;
    name: string;
    address: string;
  }>(
    `SELECT csl.signal_id, csl.parking_lot_id, p.name, p.address
     FROM cafe_signal_lots csl
     JOIN parking_lots p ON p.id = csl.parking_lot_id
     JOIN cafe_signals cs ON cs.id = csl.signal_id
     WHERE cs.human_score IS NULL`
  );

  console.log(`\n  주차장 링크 ${lotRows.length}건\n`);

  // 시그널별로 주차장 그룹핑
  const lotsMap = new Map<
    number,
    { parking_lot_id: string; name: string; address: string }[]
  >();
  for (const row of lotRows) {
    const arr = lotsMap.get(row.signal_id) ?? [];
    arr.push({
      parking_lot_id: row.parking_lot_id,
      name: row.name,
      address: row.address,
    });
    lotsMap.set(row.signal_id, arr);
  }

  const signals: SignalWithLots[] = signalRows
    .filter((s) => lotsMap.has(s.id))
    .map((s) => ({
      ...s,
      lots: lotsMap.get(s.id)!,
    }));

  // 배치 분할
  const batches: SignalWithLots[][] = [];
  for (let i = 0; i < signals.length; i += BATCH_SIZE) {
    batches.push(signals.slice(i, i + BATCH_SIZE));
  }
  console.log(
    `  ${batches.length}개 배치 (${BATCH_SIZE}건씩, 동시 ${CONCURRENCY}개)\n`
  );

  let totalProcessed = 0;
  let totalRemoved = 0;
  const allRemovals: { signalId: number; lotId: string }[] = [];

  // 동시 처리
  let idx = 0;
  async function worker() {
    while (idx < batches.length) {
      const batchIdx = idx++;
      const batch = batches[batchIdx];
      try {
        const results = await classifyBatch(batch);

        for (const signal of batch) {
          const keepIds = results.get(signal.id);
          if (keepIds === undefined) continue; // 파싱 실패 시 스킵

          const keepSet = new Set(keepIds);
          for (const lot of signal.lots) {
            if (!keepSet.has(lot.parking_lot_id)) {
              allRemovals.push({
                signalId: signal.id,
                lotId: lot.parking_lot_id,
              });
            }
          }
        }

        totalProcessed += batch.length;
        totalRemoved = allRemovals.length;
        process.stdout.write(
          `\r  진행: ${totalProcessed}/${signals.length}건 | 제거 예정: ${totalRemoved}건`
        );
      } catch (e) {
        console.error(
          `\n  ❌ 배치 ${batchIdx} API 에러:`,
          (e as Error).message
        );
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  console.log(
    `\n\n📊 결과: ${allRemovals.length}건 링크 제거 / ${lotRows.length}건 중`
  );

  // 결과 저장 (재실행 시 Haiku 호출 없이 DELETE만 가능)
  const resultsPath = resolve(import.meta.dir, "verify-lots-removals.json");
  writeFileSync(resultsPath, JSON.stringify(allRemovals));
  console.log(`  결과 저장: ${resultsPath}`);

  if (allRemovals.length === 0) {
    console.log("✅ 제거할 링크 없음.");
    return;
  }

  // 배치로 DELETE (D1 expression tree depth 100 제한 → 개별 DELETE)
  console.log("\n💾 DB 업데이트 중...");
  const DELETE_BATCH = 20;
  for (let i = 0; i < allRemovals.length; i += DELETE_BATCH) {
    const chunk = allRemovals.slice(i, i + DELETE_BATCH);
    const statements = chunk
      .map(
        (r) => `DELETE FROM cafe_signal_lots WHERE signal_id = ${r.signalId} AND parking_lot_id = '${r.lotId}';`
      )
      .join("\n");
    const tmpPath = resolve(import.meta.dir, "../.tmp-verify-lots.sql");
    writeFileSync(tmpPath, statements);
    d1ExecFile(tmpPath);
    unlinkSync(tmpPath);
    process.stdout.write(
      `\r  ${Math.min(i + DELETE_BATCH, allRemovals.length)}/${allRemovals.length}건 삭제됨`
    );
  }

  console.log(`\n\n✅ 완료! ${allRemovals.length}건 잘못된 링크 제거됨`);
}

main().catch((err) => {
  console.error("에러:", err.message);
  process.exit(1);
});
