/**
 * 감성 분석 평가: 룰 엔진 vs AI(Claude Haiku) 비교
 *
 * DB에서 웹소스 샘플을 가져와 개선 전(DB) / 개선 후(새 함수) / AI 점수를 비교.
 * 고정 샘플(id 기준 정렬)로 재현 가능.
 *
 * 사용법: bun run scripts/eval-sentiment.ts --remote
 * 환경변수: ANTHROPIC_API_KEY
 */
import { d1Query, isRemote } from "./lib/d1";
import { analyzeSentiment } from "../src/server/crawlers/lib/sentiment";

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_KEY) {
  console.error("❌ ANTHROPIC_API_KEY 환경변수 필요");
  process.exit(1);
}

// --model sonnet | haiku (default: haiku)
const MODEL_MAP: Record<string, string> = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-4-5-20241022",
};
const modelArg = process.argv.find((a) => a.startsWith("--model="))?.split("=")[1]
  ?? (process.argv.includes("--sonnet") ? "sonnet" : "haiku");
const AI_MODEL = MODEL_MAP[modelArg] ?? MODEL_MAP.haiku;

interface SampleRow {
  id: number;
  content: string;
  sentiment_score: number | null;
  relevance_score: number | null;
  name: string;
}

async function aiScore(content: string): Promise<{ score: number; reason: string }> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_KEY!,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: AI_MODEL,
      max_tokens: 200,
      messages: [
        {
          role: "user",
          content: `다음은 주차장에 대한 웹 글입니다. 이 글에서 주차장의 난이도/편의성을 1~5점으로 평가해주세요.

점수 기준:
- 5점: 매우 쉬움 (넓고 여유로움, 초보 추천)
- 4점: 쉬움 (편리하고 쾌적)
- 3점: 보통 (특별히 좋거나 나쁘지 않음, 또는 주차 난이도 관련 정보 없음)
- 2점: 어려움 (좁거나 복잡)
- 1점: 매우 어려움 (헬주차장, 기계식, 극도로 좁음)

JSON으로만 응답: {"score": 숫자, "reason": "한줄 이유"}

글:
${content.slice(0, 500)}`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${text}`);
  }

  const data = (await res.json()) as {
    content: { type: string; text: string }[];
  };
  const text = data.content[0]?.text ?? "{}";

  try {
    const jsonStr = text.replace(/```json\n?/g, "").replace(/```/g, "").trim();
    return JSON.parse(jsonStr);
  } catch {
    return { score: 3, reason: `파싱 실패: ${text.slice(0, 100)}` };
  }
}

async function main() {
  console.log(`=== 감성 분석 평가: 개선 전 vs 개선 후 vs AI (${modelArg}: ${AI_MODEL}) ===\n`);

  // 고정 샘플: id 정렬로 재현 가능 (RANDOM() 제거)
  const samples = d1Query<SampleRow>(
    `SELECT ws.id, ws.content, ws.sentiment_score, ws.relevance_score, p.name
     FROM web_sources ws
     JOIN parking_lots p ON p.id = ws.parking_lot_id
     WHERE ws.content IS NOT NULL AND ws.content != ''
       AND length(ws.content) > 80 AND ws.relevance_score >= 30
     ORDER BY ws.id
     LIMIT 30`
  );

  console.log(`샘플: ${samples.length}건\n`);
  console.log("ID     | 주차장명                | 이전  | 이후  | AI    | 차이(전) | 차이(후) | kw");
  console.log("-------|------------------------|-------|-------|-------|---------|---------|---");

  const diffsBefore: number[] = [];
  const diffsAfter: number[] = [];

  for (const s of samples) {
    // 개선 후 (damping 적용)
    const after = analyzeSentiment(s.content);

    // 개선 전: DB에 저장된 sentiment_score
    const before = s.sentiment_score ?? 3.0;

    // AI
    let ai: { score: number; reason: string };
    try {
      ai = await aiScore(s.content);
    } catch (err) {
      ai = { score: 3, reason: `ERROR: ${(err as Error).message.slice(0, 50)}` };
    }

    const diffBefore = Math.abs(before - ai.score);
    const diffAfter = Math.abs(after.sentimentScore - ai.score);
    diffsBefore.push(diffBefore);
    diffsAfter.push(diffAfter);

    const name = s.name.slice(0, 18).padEnd(18);
    const beforeStr = before.toFixed(1).padStart(4);
    const afterStr = after.sentimentScore.toFixed(1).padStart(4);
    const aiStr = ai.score.toFixed(1).padStart(4);
    const diffBStr = diffBefore.toFixed(1).padStart(6);
    const diffAStr = diffAfter.toFixed(1).padStart(6);
    const improved = diffAfter < diffBefore ? " ✅" : diffAfter > diffBefore ? " ❌" : "";
    const kw = String(after.matchCount).padStart(2);

    console.log(
      `${String(s.id).padStart(6)} | ${name} | ${beforeStr}  | ${afterStr}  | ${aiStr}  | ${diffBStr}${improved.padEnd(3)} | ${diffAStr}  | ${kw}`
    );

    await new Promise((r) => setTimeout(r, 200));
  }

  // 통계
  const n = diffsBefore.length;
  const avgBefore = diffsBefore.reduce((a, b) => a + b, 0) / n;
  const avgAfter = diffsAfter.reduce((a, b) => a + b, 0) / n;
  const bigBefore = diffsBefore.filter((d) => d >= 1.5).length;
  const bigAfter = diffsAfter.filter((d) => d >= 1.5).length;

  console.log(`\n=== 요약 ===`);
  console.log(`평균 차이: ${avgBefore.toFixed(2)} → ${avgAfter.toFixed(2)} (${avgAfter < avgBefore ? "개선 ✅" : "악화 ❌"})`);
  console.log(`큰 차이(>=1.5): ${bigBefore}/${n}건 → ${bigAfter}/${n}건 (${bigAfter < bigBefore ? "개선 ✅" : bigAfter === bigBefore ? "동일" : "악화 ❌"})`);

  // 키워드 3개+ 케이스 영향 확인
  let unchanged = 0;
  let total3plus = 0;
  for (const s of samples) {
    const after = analyzeSentiment(s.content);
    if (after.matchCount >= 3) {
      total3plus++;
      const before = s.sentiment_score ?? 3.0;
      if (Math.abs(after.sentimentScore - before) < 0.01) unchanged++;
    }
  }
  console.log(`키워드 3개+: ${total3plus}건 중 ${unchanged}건 변경 없음 (${total3plus > 0 ? ((unchanged / total3plus) * 100).toFixed(0) : 0}%)`);
}

main().catch((err) => {
  console.error("❌", err.message);
  process.exit(1);
});
