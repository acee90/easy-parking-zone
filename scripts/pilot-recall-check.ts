/**
 * Recall 측정: 필터 제거된 건 중 샘플에 AI 매칭을 돌려 FN 확인
 *
 * Usage:
 *   bun run scripts/pilot-recall-check.ts --remote
 */
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { d1Query } from "./lib/d1";
import { sleep } from "./lib/geo";

const client = new Anthropic();
const DIR = resolve(import.meta.dir);
const DATA_FILE = resolve(DIR, "pilot-region-hanam-data.json");
const RESULT_FILE = resolve(DIR, "pilot-recall-check-result.json");

const PARKING_KW = [
  "주차", "parking", "주차장", "주차비", "주차요금", "주차면", "주차칸",
  "발렛", "기계식", "자주식", "무료주차", "유료주차", "주차타워",
];
const EXCLUDE_KW = [
  "경매", "분양", "매매", "임대", "모델하우스", "입찰", "낙찰", "감정가",
  "체험단", "원룸", "투룸",
];

interface CollectedItem {
  id: number;
  source: string;
  sourceUrl: string;
  title: string;
  snippet: string;
  parkingLotId: string;
  lotName: string;
  lotLat: number;
  lotLng: number;
  fullText: string | null;
  fullTextLength: number;
  nearbyLotCount: number;
  filterPassed: boolean;
  aiMatches: Array<{ lotId: string; lotName: string; confidence: string; reason: string }>;
  aiError: string | null;
}

interface ParkingLot {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
}

function classifyRemoval(d: CollectedItem): string {
  const text = (d.fullText ?? "").toLowerCase();
  const tlen = d.fullTextLength;
  if (tlen < 100) return "tooShort";
  if (EXCLUDE_KW.some((kw) => text.includes(kw))) return "excludeKeyword";
  if (!PARKING_KW.some((kw) => text.includes(kw))) return "noParkingKeyword";
  const parkCnt = (text.match(/주차/g) || []).length;
  const density = parkCnt / Math.max(tlen, 1) * 1000;
  if (density < 1.0) return "lowParkingDensity";
  return "other";
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const SYSTEM_PROMPT = `당신은 주차장 매칭 전문가입니다. 블로그/카페 글의 본문을 읽고, 이 글이 실제로 어떤 주차장(들)에 대해 이야기하고 있는지 판단합니다.

주변 주차장 후보 목록이 주어집니다. 글에서 실제로 언급하거나, 주차 경험을 서술하거나, 추천/비추천하는 주차장만 선택하세요.

규칙:
- 글에서 직접 이름이 언급되거나 명확히 지칭하는 주차장만 선택
- 글이 특정 장소(백화점, 역, 공원 등) 방문기이고 "주차했다"고만 하면, 그 장소의 공식 주차장을 선택
- 주차와 관련 없는 단순 언급은 제외
- 확신이 없으면 confidence: "low"로 표시

반드시 아래 JSON 형식으로만 응답하세요:
{
  "matches": [
    {
      "lotId": "주차장 ID",
      "lotName": "주차장 이름",
      "confidence": "high" | "medium" | "low",
      "reason": "선택 이유 (1줄)"
    }
  ]
}

매칭되는 주차장이 없으면 빈 배열: {"matches": []}`;

async function aiMatch(
  text: string,
  nearbyLots: ParkingLot[],
): Promise<CollectedItem["aiMatches"]> {
  const truncated = text.slice(0, 2000);
  const lotList = nearbyLots
    .slice(0, 30)
    .map((l) => `- ID: ${l.id} | 이름: ${l.name} | 주소: ${l.address}`)
    .join("\n");

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 500,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `## 본문 (발췌)\n${truncated}\n\n## 주변 주차장 후보 (${nearbyLots.length}개 중 상위 30개)\n${lotList}\n\n이 글이 어떤 주차장에 대해 이야기하고 있나요?`,
      },
    ],
  });

  const respText = response.content[0].type === "text" ? response.content[0].text : "";
  const jsonMatch = respText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return [];
  const parsed = JSON.parse(jsonMatch[0]);
  return parsed.matches ?? [];
}

async function main() {
  const items: CollectedItem[] = JSON.parse(readFileSync(DATA_FILE, "utf-8"));
  const removed = items.filter((d) => !d.filterPassed);

  // 사유별 분류
  const byReason: Record<string, CollectedItem[]> = {};
  for (const d of removed) {
    const reason = classifyRemoval(d);
    (byReason[reason] ??= []).push(d);
  }

  console.log("필터 제거 건 분류:");
  for (const [r, arr] of Object.entries(byReason)) {
    console.log(`  ${r}: ${arr.length}건`);
  }

  // FN 위험 그룹: lowParkingDensity(전체) + excludeKeyword(샘플 10건)
  const targets = [
    ...(byReason["lowParkingDensity"] ?? []),
    ...(byReason["excludeKeyword"] ?? []).slice(0, 10),
  ];

  console.log(`\nAI 매칭 대상: ${targets.length}건\n`);

  // 주차장 DB 로드
  console.log("DB 주차장 로드...");
  const allLots = d1Query<ParkingLot>(
    "SELECT id, name, address, lat, lng FROM parking_lots"
  );
  console.log(`${allLots.length}개 주차장\n`);

  const results: Array<{
    id: number;
    title: string;
    source: string;
    reason: string;
    lotName: string;
    aiMatches: CollectedItem["aiMatches"];
    aiError: string | null;
  }> = [];

  for (let i = 0; i < targets.length; i++) {
    const d = targets[i];
    const reason = classifyRemoval(d);
    process.stdout.write(`\r[Recall] ${i + 1}/${targets.length}`);

    // nearby lots 계산
    const nearby = allLots
      .map((l) => ({ ...l, dist: haversineKm(d.lotLat, d.lotLng, l.lat, l.lng) }))
      .filter((l) => l.dist <= 5)
      .sort((a, b) => a.dist - b.dist);

    let matches: CollectedItem["aiMatches"] = [];
    let error: string | null = null;
    try {
      matches = await aiMatch(d.fullText ?? d.snippet, nearby);
    } catch (e: any) {
      error = e.message;
    }

    results.push({
      id: d.id,
      title: d.title,
      source: d.source,
      reason,
      lotName: d.lotName,
      aiMatches: matches,
      aiError: error,
    });

    await sleep(100);
  }

  console.log("\n\n═══ Recall 체크 결과 ═══\n");

  const fn = results.filter((r) => r.aiMatches.length > 0);
  const tn = results.filter((r) => r.aiMatches.length === 0 && !r.aiError);
  const errored = results.filter((r) => r.aiError);

  console.log(`  검사: ${results.length}건`);
  console.log(`  FN (필터 제거 + AI 매칭 O): ${fn.length}건`);
  console.log(`  TN (필터 제거 + AI 매칭 X): ${tn.length}건`);
  console.log(`  AI 에러: ${errored.length}건\n`);

  if (fn.length > 0) {
    console.log("═══ FALSE NEGATIVES ═══\n");
    for (const r of fn) {
      const aiStr = r.aiMatches.map((m) => `${m.lotName}(${m.confidence})`).join(", ");
      console.log(`  #${r.id} [${r.source}] [${r.reason}] ${r.title.slice(0, 55)}`);
      console.log(`    기존lot: ${r.lotName}`);
      console.log(`    AI매칭: ${aiStr}\n`);
    }
  }

  // 사유별 FN 비율
  console.log("═══ 사유별 FN 비율 ═══\n");
  const reasonStats: Record<string, { total: number; fn: number }> = {};
  for (const r of results) {
    const s = (reasonStats[r.reason] ??= { total: 0, fn: 0 });
    s.total++;
    if (r.aiMatches.length > 0) s.fn++;
  }
  for (const [reason, s] of Object.entries(reasonStats)) {
    console.log(`  ${reason}: ${s.fn}/${s.total} FN (${(s.fn / s.total * 100).toFixed(0)}%)`);
  }

  writeFileSync(RESULT_FILE, JSON.stringify(results, null, 2));
  console.log(`\n결과 저장: ${RESULT_FILE}`);
}

main();
