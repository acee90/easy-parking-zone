/**
 * 광고 필터링 검증 — Haiku로 샘플 검증
 *
 * 1. 스크립트가 광고로 판정한 938건 전수 → 정밀도(precision)
 * 2. 스크립트가 통과시킨 것 중 랜덤 1000건 → 재현율(recall)
 *
 * Usage:
 *   bun scripts/validate-ad-filter.ts --remote
 */
import { d1Query, isRemote } from "./lib/d1";
import { writeFileSync } from "fs";
import { join } from "path";

const AD_PATTERNS = [
  /모델하우스/, /분양가/, /분양정보/, /분양조건/, /잔여세대/,
  /견본주택/, /입주자모집/, /입주예정/, /공급조건/,
  /시행사/, /시공사/, /투자수익/, /프리미엄분양/,
  /빌라\s*매매/, /아파트\s*매매/, /매물/, /전세\s*모/, /월세\s*모/,
  /원룸\s*\d/, /투룸/, /쓰리룸/, /임대\s*안/,
  /신축빌라/, /신축원룸/, /경매물건/,
  /임장\s*(기록|후기|보고)/, /지구\s*임장/,
  /체험단.*모집/, /업체\s*추천\s*(깔끔|꼼꼼)/, /메디컬빌딩/,
  /살인사건/, /뮤지컬\s*(렌트|위키드|캣츠)/, /커튼콜/,
  /추경예산/, /예산\s*편성/,
];

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY가 .env에 설정되지 않았습니다.");
  process.exit(1);
}

interface Row {
  id: number;
  title: string;
  content: string;
  source: string;
  parking_lot_id: string;
}

// Haiku 배치 분류 (한 번에 20건씩)
async function classifyBatch(items: Row[]): Promise<Map<number, boolean>> {
  const entries = items.map((r, i) =>
    `[${i}] title: ${r.title.slice(0, 80)}\nsnippet: ${r.content.slice(0, 150)}`
  ).join("\n\n");

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
      messages: [{
        role: "user",
        content: `아래 텍스트들이 주차장 이용 후기인지, 아니면 광고/분양/홍보 콘텐츠인지 판별해줘.
각 항목에 대해 "광고"면 1, "주차 관련 실제 콘텐츠"면 0으로 답해.
형식: 번호:판정 (예: 0:1,1:0,2:0,...)
판정 기준: 부동산 분양, 모델하우스, 오피스텔 홍보, 아파트 광고 등은 "광고". 주차장 이용 경험, 주차 팁, 주차장 리뷰 등은 "실제 콘텐츠".

${entries}`
      }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Haiku API ${res.status}: ${err}`);
  }

  const data = await res.json() as { content: Array<{ text: string }> };
  const text = data.content[0].text;

  // 파싱: "0:1,1:0,2:1,..."
  const result = new Map<number, boolean>();
  const matches = text.matchAll(/(\d+)\s*:\s*([01])/g);
  for (const m of matches) {
    const idx = parseInt(m[1]);
    const isAd = m[2] === "1";
    if (idx < items.length) {
      result.set(items[idx].id, isAd);
    }
  }
  return result;
}

async function main() {
  console.log(`[검증] ${isRemote ? "REMOTE" : "LOCAL"} D1`);

  // 전체 텍스트 로드
  console.log("[검증] 텍스트 로드 중...");
  const allRows = d1Query<Row>(
    "SELECT id, title, content, source, parking_lot_id FROM web_sources WHERE sentiment_score IS NOT NULL OR relevance_score > 30",
  );
  console.log(`[검증] 전체 ${allRows.length}건`);

  // 스크립트 판정 분리
  const scriptAd: Row[] = [];
  const scriptPass: Row[] = [];
  for (const r of allRows) {
    const text = `${r.title} ${r.content}`;
    if (AD_PATTERNS.some((p) => p.test(text))) {
      scriptAd.push(r);
    } else {
      scriptPass.push(r);
    }
  }
  console.log(`[검증] 스크립트 광고: ${scriptAd.length}건, 통과: ${scriptPass.length}건`);

  // 통과 중 랜덤 1000건 샘플
  const sampleSize = Math.min(1000, scriptPass.length);
  const shuffled = scriptPass.sort(() => Math.random() - 0.5);
  const passSample = shuffled.slice(0, sampleSize);

  const targets = [
    { label: "광고 판정", items: scriptAd },
    { label: "통과 샘플", items: passSample },
  ];

  const BATCH = 20;
  const results: Array<{
    id: number;
    scriptIsAd: boolean;
    haikuIsAd: boolean;
    title: string;
    source: string;
  }> = [];

  for (const { label, items } of targets) {
    const isScriptAd = label === "광고 판정";
    console.log(`\n[검증] ${label} ${items.length}건 Haiku 분류 시작...`);

    for (let i = 0; i < items.length; i += BATCH) {
      const batch = items.slice(i, i + BATCH);
      try {
        const haikuResults = await classifyBatch(batch);
        for (const row of batch) {
          const haikuIsAd = haikuResults.get(row.id);
          if (haikuIsAd !== undefined) {
            results.push({
              id: row.id,
              scriptIsAd: isScriptAd,
              haikuIsAd,
              title: row.title.slice(0, 60),
              source: row.source,
            });
          }
        }
      } catch (err) {
        console.error(`  배치 실패: ${(err as Error).message}`);
      }

      if ((i / BATCH) % 10 === 0) {
        process.stdout.write(`\r  ${Math.min(i + BATCH, items.length)}/${items.length}`);
      }
    }
    console.log();
  }

  // 분석
  const scriptAdResults = results.filter((r) => r.scriptIsAd);
  const scriptPassResults = results.filter((r) => !r.scriptIsAd);

  const truePositive = scriptAdResults.filter((r) => r.haikuIsAd).length;   // 둘 다 광고
  const falsePositive = scriptAdResults.filter((r) => !r.haikuIsAd).length;  // 스크립트만 광고
  const falseNegative = scriptPassResults.filter((r) => r.haikuIsAd).length; // Haiku만 광고
  const trueNegative = scriptPassResults.filter((r) => !r.haikuIsAd).length; // 둘 다 통과

  const precision = truePositive / (truePositive + falsePositive) || 0;
  const recallSample = 1 - (falseNegative / scriptPassResults.length) || 0;

  console.log("\n[검증] === 결과 ===");
  console.log(`  스크립트 광고 판정: ${scriptAdResults.length}건`);
  console.log(`    ✅ Haiku도 광고 (TP): ${truePositive}`);
  console.log(`    ❌ Haiku는 정상 (FP): ${falsePositive}`);
  console.log(`  스크립트 통과 샘플: ${scriptPassResults.length}건`);
  console.log(`    ✅ Haiku도 정상 (TN): ${trueNegative}`);
  console.log(`    ❌ Haiku는 광고 (FN): ${falseNegative}`);
  console.log();
  console.log(`  정밀도 (Precision): ${(precision * 100).toFixed(1)}%`);
  console.log(`  재현율 (샘플 기준):  ${(recallSample * 100).toFixed(1)}%`);
  console.log(`  추정 미검출 광고:    ~${Math.round(falseNegative / scriptPassResults.length * scriptPass.length)}건`);

  // FP/FN 상세 저장
  const details = {
    summary: { precision, recallSample, truePositive, falsePositive, falseNegative, trueNegative },
    falsePositives: results.filter((r) => r.scriptIsAd && !r.haikuIsAd),
    falseNegatives: results.filter((r) => !r.scriptIsAd && r.haikuIsAd),
  };
  const outPath = join(import.meta.dirname, "ad-filter-validation.json");
  writeFileSync(outPath, JSON.stringify(details, null, 2));
  console.log(`\n[검증] 상세 결과: ${outPath}`);
}

main().catch(console.error);
