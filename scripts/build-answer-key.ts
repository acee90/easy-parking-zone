/**
 * 고정 답지 생성 스크립트
 *
 * /tmp/answer-key-samples-200.json → AI 판정 → scripts/answer-key.json 저장
 * 이후 scoring 로직 변경 시 이 답지와 비교하여 F1 측정
 *
 * Usage: bun run scripts/build-answer-key.ts
 */
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

const API_KEY = process.env.ANTHROPIC_API_KEY!;
if (!API_KEY) { console.error("ANTHROPIC_API_KEY 필요"); process.exit(1); }

const BATCH_SIZE = 25; // Haiku 배치 크기

interface Sample {
  id: number;
  score: number;
  source: string;
  title: string;
  content: string;
  lot_name: string;
  lot_addr: string;
}

interface Verdict {
  id: number;
  relevant: boolean;
  reason: string;
}

interface AnswerKeyEntry {
  id: number;
  score: number;
  source: string;
  title: string;
  content: string;
  lot_name: string;
  lot_addr: string;
  relevant: boolean;
  reason: string;
}

const SYSTEM = `주차장-글 매칭 검증기입니다. 각 항목은 "이 글이 이 주차장에 관련있는지"를 판단합니다.

JSON 배열로 출력하세요:
[{"id": 번호, "relevant": true/false, "reason": "이유 10자"}]

엄격한 판단 기준:
- relevant=true: 글에 해당 주차장 이름(또는 명확히 같은 시설)이 직접 언급되어야 함
- relevant=false: 아래 경우 모두 false
  - 글에 해당 주차장 이름이 등장하지 않음
  - 같은 동네/지역일 뿐 해당 주차장을 언급하지 않음
  - 근처 시설(백화점, 마트 등)의 주차 이야기이지만 해당 주차장명은 없음
  - 부동산, 구인, 광고, 뉴스 등 무관 콘텐츠
  - "XX 주차장 Top5" 제목이지만 매칭 주차장명이 XX와 다르고 본문에도 없음

핵심: "같은 동네라서" "근처 시설이라서"는 relevant가 아닙니다. 주차장 이름이 글에 직접 나와야 합니다.`;

async function classifyBatch(items: string): Promise<Verdict[]> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4096,
      system: SYSTEM,
      messages: [{ role: "user", content: items }],
    }),
    signal: AbortSignal.timeout(90_000),
  });

  const data = (await res.json()) as { content: Array<{ text: string }> };
  const text = data.content[0].text;
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  return JSON.parse(match[0]) as Verdict[];
}

async function main() {
  const raw = readFileSync("/tmp/answer-key-samples-200.json", "utf-8");
  const samples: Sample[] = JSON.parse(raw)[0].results;

  console.log(`\n🎯 고정 답지 생성 (${samples.length}건, ${BATCH_SIZE}건씩 배치)\n`);

  const answerKey: AnswerKeyEntry[] = [];

  for (let i = 0; i < samples.length; i += BATCH_SIZE) {
    const chunk = samples.slice(i, i + BATCH_SIZE);
    const items = chunk.map((s, j) =>
      `[${j + 1}] 주차장="${s.lot_name}" (${s.lot_addr.slice(0, 30)}) | 점수=${s.score} | 제목: ${s.title.slice(0, 65)} | 내용: ${(s.content || "").slice(0, 150)}`
    ).join("\n");

    process.stdout.write(`  [${i + 1}~${i + chunk.length}/${samples.length}] `);

    try {
      const verdicts = await classifyBatch(items);
      const vMap = new Map(verdicts.map(v => [v.id, v]));

      let relevant = 0;
      for (let j = 0; j < chunk.length; j++) {
        const s = chunk[j];
        const v = vMap.get(j + 1) ?? { relevant: false, reason: "판정 실패" };
        answerKey.push({ ...s, relevant: v.relevant, reason: v.reason });
        if (v.relevant) relevant++;
      }
      console.log(`${relevant}/${chunk.length} relevant`);
    } catch (err) {
      console.log(`❌ ${(err as Error).message}`);
      for (const s of chunk) {
        answerKey.push({ ...s, relevant: false, reason: "API 에러" });
      }
    }

    await new Promise(r => setTimeout(r, 500));
  }

  const outPath = resolve(import.meta.dir, "answer-key.json");
  writeFileSync(outPath, JSON.stringify(answerKey, null, 2));

  const relevantCount = answerKey.filter(a => a.relevant).length;
  console.log(`\n📊 답지 생성 완료`);
  console.log(`  전체: ${answerKey.length}건`);
  console.log(`  relevant: ${relevantCount}건 (${(relevantCount/answerKey.length*100).toFixed(0)}%)`);
  console.log(`  저장: ${outPath}\n`);
}

main().catch(console.error);
