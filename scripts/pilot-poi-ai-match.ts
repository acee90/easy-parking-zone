/**
 * POI 파일럿: AI 기반 주차장 매칭
 *
 * pilot-fulltext-result-v2.json의 블로그 원문 + 근처 주차장 후보를 AI에 전달하여
 * "이 블로그가 실제로 어떤 주차장에 대해 말하고 있는지" 판단.
 *
 * 키워드 매칭 결과와 비교하여 정확도 리포트 생성.
 *
 * 사용법:
 *   bun run scripts/pilot-poi-ai-match.ts
 */
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { d1Query, isRemote } from "./lib/d1";
import { sleep } from "./lib/geo";

const client = new Anthropic();

const DIR = resolve(import.meta.dir);
const INPUT_FILE = resolve(DIR, "pilot-fulltext-result-v2.json");
const RESULT_FILE = resolve(DIR, "pilot-ai-match-result.json");
const API_DELAY = 300;

// ─── 타입 ──────────────────────────────────────────────
interface FetchResult {
  id: number;
  sourceUrl: string;
  currentLotId: string;
  currentLotName: string;
  fullText: string | null;
  fullTextLength: number;
  fetchError: string | null;
  matches: Array<{
    lotId: string;
    lotName: string;
    matchedKeywords: string[];
    keywordCount: number;
    contextSnippet: string;
  }>;
}

interface ParkingLot {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
}

interface AiMatchResult {
  id: number;
  sourceUrl: string;
  blogTitle: string;
  currentLotId: string;
  currentLotName: string;
  // 키워드 매칭 결과
  keywordMatches: string[];
  // AI 매칭 결과
  aiMatches: Array<{
    lotId: string;
    lotName: string;
    confidence: "high" | "medium" | "low";
    reason: string;
  }>;
  aiError: string | null;
}

// ─── Haversine ──────────────────────────────────────────
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── AI 매칭 ──────────────────────────────────────────
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
  blogText: string,
  nearbyLots: ParkingLot[],
): Promise<Array<{ lotId: string; lotName: string; confidence: string; reason: string }>> {
  // 본문 2000자 제한 (토큰 절약)
  const truncatedText = blogText.slice(0, 2000);

  // 주차장 후보 리스트 (최대 30개, 가까운 순)
  const lotList = nearbyLots.slice(0, 30).map((l) =>
    `- ID: ${l.id} | 이름: ${l.name} | 주소: ${l.address}`
  ).join("\n");

  const userPrompt = `## 블로그 본문 (발췌)
${truncatedText}

## 주변 주차장 후보 (${nearbyLots.length}개 중 상위 30개)
${lotList}

이 블로그가 어떤 주차장에 대해 이야기하고 있나요?`;

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 500,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
  });

  const text = response.content[0].type === "text" ? response.content[0].text : "";

  // JSON 파싱
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return [];

  const parsed = JSON.parse(jsonMatch[0]);
  return parsed.matches ?? [];
}

// ─── 메인 ───────────────────────────────────────────────
async function main() {
  console.log("[AI-Match] POI AI 매칭 파일럿\n");

  // 1. 키워드 매칭 결과 로드
  if (!existsSync(INPUT_FILE)) {
    console.error(`${INPUT_FILE} 없음. pilot-poi-fulltext.ts를 먼저 실행하세요.`);
    process.exit(1);
  }
  const fullTextResults: FetchResult[] = JSON.parse(readFileSync(INPUT_FILE, "utf-8"));
  const withText = fullTextResults.filter((r) => r.fullText && r.fullTextLength > 100);
  console.log(`[AI-Match] 입력: ${withText.length}건 (본문 100자 이상)\n`);

  // 2. DB 주차장 로드 (좌표 포함)
  console.log("[AI-Match] DB 주차장 로드 중...");
  const allLots = d1Query<ParkingLot>(
    "SELECT id, name, address, lat, lng FROM parking_lots",
  );
  console.log(`[AI-Match] ${allLots.length}개 주차장\n`);

  // 3. 샘플에서 좌표 로드
  const sampleFile = resolve(DIR, "pilot-fulltext-sample-v2.json");
  const samples: Array<{ id: number; lot_lat: number; lot_lng: number; title: string }> =
    JSON.parse(readFileSync(sampleFile, "utf-8"));
  const sampleMap = new Map(samples.map((s) => [s.id, s]));

  // 4. AI 매칭 실행
  const results: AiMatchResult[] = [];
  let processed = 0;

  for (const item of withText) {
    processed++;
    const sample = sampleMap.get(item.id);
    if (!sample) continue;

    process.stdout.write(`\r[AI-Match] ${processed}/${withText.length}...`);

    // 5km 이내 주차장 후보
    const nearby = allLots
      .map((l) => ({ ...l, dist: haversineKm(sample.lot_lat, sample.lot_lng, l.lat, l.lng) }))
      .filter((l) => l.dist <= 5)
      .sort((a, b) => a.dist - b.dist);

    let aiMatches: Array<{ lotId: string; lotName: string; confidence: string; reason: string }> = [];
    let aiError: string | null = null;

    try {
      aiMatches = await aiMatch(item.fullText!, nearby);
    } catch (err) {
      aiError = (err as Error).message;
    }

    results.push({
      id: item.id,
      sourceUrl: item.sourceUrl,
      blogTitle: sample.title,
      currentLotId: item.currentLotId,
      currentLotName: item.currentLotName,
      keywordMatches: item.matches.map((m) => m.lotName),
      aiMatches: aiMatches as AiMatchResult["aiMatches"],
      aiError,
    });

    await sleep(API_DELAY);
  }

  // 5. 비교 리포트
  console.log(`\n\n[AI-Match] === 결과 요약 ===`);

  let aiFound = 0;
  let aiEmpty = 0;
  let aiError = 0;
  let aiMatchedCurrent = 0; // AI가 기존 매칭 주차장을 포함
  let kwMatchedCurrent = 0; // 키워드가 기존 매칭 주차장을 포함
  let aiHighConf = 0;

  for (const r of results) {
    if (r.aiError) { aiError++; continue; }
    if (r.aiMatches.length === 0) { aiEmpty++; continue; }
    aiFound++;

    if (r.aiMatches.some((m) => m.lotId === r.currentLotId)) aiMatchedCurrent++;
    if (r.keywordMatches.length > 0) {
      // 키워드 매칭에 기존 lot이 있는지 (lot name 기반)
      const kwNames = new Set(r.keywordMatches);
      if (kwNames.has(r.currentLotName)) kwMatchedCurrent++;
    }

    aiHighConf += r.aiMatches.filter((m) => m.confidence === "high").length;
  }

  console.log(`  AI 매칭 성공: ${aiFound}건, 매칭 없음: ${aiEmpty}건, 에러: ${aiError}건`);
  console.log(`  AI가 기존 lot 포함: ${aiMatchedCurrent}/${aiFound}건`);
  console.log(`  키워드가 기존 lot 포함: ${kwMatchedCurrent}/${results.length}건`);
  console.log(`  AI high confidence: ${aiHighConf}건`);

  // 상세 비교
  console.log(`\n[AI-Match] === 상세 비교 ===`);
  for (const r of results) {
    if (r.aiError) continue;

    const aiLots = r.aiMatches.map((m) => `${m.lotName}(${m.confidence})`);
    const kwLots = r.keywordMatches.slice(0, 5);
    const aiHasCurrent = r.aiMatches.some((m) => m.lotId === r.currentLotId);
    const kwHasCurrent = kwLots.includes(r.currentLotName);

    // 차이가 있는 것만 출력
    if (aiLots.length > 0 || kwLots.length > 0) {
      console.log(`\n  제목: ${r.blogTitle.slice(0, 70)}`);
      console.log(`  기존: ${r.currentLotName} ${aiHasCurrent ? "✅AI" : "❌AI"} ${kwHasCurrent ? "✅KW" : "❌KW"}`);
      if (aiLots.length > 0) console.log(`  AI:  ${aiLots.join(", ")}`);
      if (kwLots.length > 0) console.log(`  KW:  ${kwLots.join(", ")}`);
      for (const m of r.aiMatches) {
        console.log(`    → ${m.lotName}: ${m.reason}`);
      }
    }
  }

  // 저장
  writeFileSync(RESULT_FILE, JSON.stringify(results, null, 2), "utf-8");
  console.log(`\n[AI-Match] 결과 저장 → ${RESULT_FILE}`);
}

main().catch((err) => {
  console.error("\n에러:", err.message);
  process.exit(1);
});
