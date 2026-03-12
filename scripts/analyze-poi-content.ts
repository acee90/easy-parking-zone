/**
 * POI 주차 콘텐츠 AI 분석
 *
 * poi-content-result.json의 수집 콘텐츠를 Claude로 분석하여
 * 주차장 이름, 요금, 팁, 난이도 등 구조화된 정보 추출
 *
 * 사용법: bun run scripts/analyze-poi-content.ts
 */
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { sleep } from "./lib/geo";

const client = new Anthropic();

const DIR = resolve(import.meta.dir);
const inputArg = process.argv.find((a) => a.startsWith("--input="))?.split("=")[1];
const CONTENT_FILE = resolve(DIR, inputArg ?? "poi-content-result.json");
const outName = inputArg ? inputArg.replace("poi-content-", "poi-analysis-") : "poi-analysis-result.json";
const OUT_FILE = resolve(DIR, outName);

const API_DELAY = 500;

// --- Types ---
interface ParkingLotInfo {
  name: string;
  fee?: string;
  freeCondition?: string;
  tips?: string[];
}

interface PoiAnalysis {
  poiName: string;
  address: string;
  categoryLabel: string;
  lat: number;
  lng: number;
  kakaoId: string;
  parkingLots: ParkingLotInfo[];
  generalTips: string[];
  difficulty: "easy" | "normal" | "hard" | "unknown";
  difficultyReason: string;
  summary: string;
}

// --- AI 분석 ---
const SYSTEM_PROMPT = `당신은 주차 정보 분석 전문가입니다. 블로그/카페 글 스니펫을 분석하여 구조화된 주차 정보를 추출합니다.

반드시 아래 JSON 형식으로만 응답하세요. 다른 텍스트 없이 JSON만 출력하세요.

{
  "parkingLots": [
    {
      "name": "주차장 이름",
      "fee": "요금 정보 (예: 최초 30분 무료, 이후 10분당 1000원)",
      "freeCondition": "무료 주차 조건 (예: 3만원 이상 구매 시 2시간 무료)",
      "tips": ["주차 팁1", "주차 팁2"]
    }
  ],
  "generalTips": ["해당 장소 방문 시 주차 관련 일반 팁"],
  "difficulty": "easy|normal|hard|unknown",
  "difficultyReason": "난이도 판단 근거 한 문장",
  "summary": "이 장소의 주차 상황 요약 2-3문장"
}

규칙:
- parkingLots: 글에서 언급된 실제 주차장만 추출. 추측 금지.
- fee: 글에 명시된 요금만. 없으면 생략.
- difficulty: easy(넓고 자리 많음), normal(보통), hard(좁거나 복잡하거나 자리 부족)
- 글에서 정보를 찾을 수 없는 필드는 생략
- 중복 주차장은 합쳐서 정보 통합`;

async function analyzePoi(
  poiName: string,
  posts: { source: string; title: string; snippet: string }[],
): Promise<PoiAnalysis | null> {
  const postsText = posts
    .map((p) => `[${p.source}] ${p.title}\n${p.snippet}`)
    .join("\n\n");

  const userPrompt = `"${poiName}" 주변 주차 정보를 아래 블로그/카페 글에서 추출해주세요.\n\n${postsText}`;

  try {
    const res = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    });

    const text =
      res.content[0].type === "text" ? res.content[0].text : "";

    // JSON 파싱 (코드블록 감싸기 대응)
    const jsonStr = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const parsed = JSON.parse(jsonStr);
    return parsed;
  } catch (e) {
    console.log(`    ⚠️ 분석 실패: ${e}`);
    return null;
  }
}

// --- 메인 ---
async function main() {
  const content = JSON.parse(readFileSync(CONTENT_FILE, "utf-8"));
  const results: (PoiAnalysis & { relevantCount: number })[] = [];

  console.log(`=== POI 주차 콘텐츠 AI 분석 ===`);
  console.log(`대상 POI: ${content.results.length}건\n`);

  for (let i = 0; i < content.results.length; i++) {
    const r = content.results[i];
    console.log(
      `[${i + 1}/${content.results.length}] "${r.name}" (${r.posts.length}건 분석)...`,
    );

    const analysis = await analyzePoi(r.name, r.posts);

    if (analysis) {
      results.push({
        poiName: r.name,
        address: r.address,
        categoryLabel: r.categoryLabel,
        lat: r.lat,
        lng: r.lng,
        kakaoId: r.kakaoId,
        parkingLots: analysis.parkingLots ?? [],
        generalTips: analysis.generalTips ?? [],
        difficulty: analysis.difficulty ?? "unknown",
        difficultyReason: analysis.difficultyReason ?? "",
        summary: analysis.summary ?? "",
        relevantCount: r.relevantCount,
      });

      const lotCount = analysis.parkingLots?.length ?? 0;
      console.log(
        `  → 주차장 ${lotCount}곳, 난이도: ${analysis.difficulty}, 팁 ${analysis.generalTips?.length ?? 0}건`,
      );
    } else {
      results.push({
        poiName: r.name,
        address: r.address,
        categoryLabel: r.categoryLabel,
        lat: r.lat,
        lng: r.lng,
        kakaoId: r.kakaoId,
        parkingLots: [],
        generalTips: [],
        difficulty: "unknown",
        difficultyReason: "",
        summary: "",
        relevantCount: r.relevantCount,
      });
    }

    await sleep(API_DELAY);
  }

  // 저장
  const output = {
    meta: {
      createdAt: new Date().toISOString(),
      model: "claude-haiku-4-5-20251001",
      totalPois: results.length,
      totalParkingLots: results.reduce(
        (sum, r) => sum + r.parkingLots.length,
        0,
      ),
    },
    results,
  };

  writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));

  // 요약
  console.log("\n" + "=".repeat(50));
  console.log("📋 분석 요약");
  console.log("=".repeat(50));
  console.log(`총 POI: ${results.length}건`);
  console.log(
    `추출된 주차장: ${output.meta.totalParkingLots}곳`,
  );

  const diff = { easy: 0, normal: 0, hard: 0, unknown: 0 };
  for (const r of results) diff[r.difficulty]++;
  console.log(
    `난이도 분포: 😊쉬움 ${diff.easy} / 🙂보통 ${diff.normal} / 💀어려움 ${diff.hard} / ❓모름 ${diff.unknown}`,
  );

  console.log("\n📊 POI별 분석:");
  for (const r of results) {
    const icon =
      r.difficulty === "easy"
        ? "😊"
        : r.difficulty === "hard"
          ? "💀"
          : r.difficulty === "normal"
            ? "🙂"
            : "❓";
    console.log(
      `  ${icon} ${r.poiName} — 주차장 ${r.parkingLots.length}곳 | ${r.summary.substring(0, 60)}`,
    );
  }

  console.log(`\n💾 결과 저장: ${OUT_FILE}`);
}

main().catch((e) => {
  console.error("오류 발생:", e);
  process.exit(1);
});
