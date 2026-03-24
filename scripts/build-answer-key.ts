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

판단 기준:
- relevant=true: 글이 해당 주차장을 직접 언급하거나, 해당 주차장의 주차 정보/경험을 담고 있음
- relevant=false: 글이 해당 주차장과 무관 (같은 동네일 뿐, 다른 장소 이야기, 부동산, 구인 등)
- 글 제목에 "XX 주차장 Top5"이고 매칭된 주차장명이 XX와 다르면 → 본문에 해당 주차장이 실제로 소개되는지 확인 필요 (제목만으로 false)`;

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
