/**
 * 매칭 로직 답지 생성 스크립트
 *
 * 점수대별 샘플을 뽑아 AI로 "이 글이 이 주차장에 관련있는지" 판정.
 * 현재 threshold 기준의 confusion matrix 출력.
 *
 * Usage: bun run scripts/matching-answer-key.ts --remote
 */
import { d1Query, isRemote } from "./lib/d1";
import { scoreBlogRelevance, stripHtml } from "../src/server/crawlers/lib/scoring";

const API_KEY = process.env.ANTHROPIC_API_KEY!;
if (!API_KEY) { console.error("ANTHROPIC_API_KEY 필요"); process.exit(1); }

const THRESHOLD = 60;

interface Row {
  id: number;
  score: number;
  source: string;
  title: string;
  content: string;
  lot_name: string;
  lot_addr: string;
}

// 점수대별 10건씩 = 40건 샘플
const samples = d1Query<Row>(`
  SELECT * FROM (
    SELECT ws.id, ws.relevance_score as score, ws.source, ws.title, ws.content, p.name as lot_name, p.address as lot_addr
    FROM web_sources ws JOIN parking_lots p ON p.id = ws.parking_lot_id
    WHERE ws.relevance_score <= 20 ORDER BY RANDOM() LIMIT 10
  ) UNION ALL SELECT * FROM (
    SELECT ws.id, ws.relevance_score, ws.source, ws.title, ws.content, p.name, p.address
    FROM web_sources ws JOIN parking_lots p ON p.id = ws.parking_lot_id
    WHERE ws.relevance_score BETWEEN 30 AND 50 ORDER BY RANDOM() LIMIT 10
  ) UNION ALL SELECT * FROM (
    SELECT ws.id, ws.relevance_score, ws.source, ws.title, ws.content, p.name, p.address
    FROM web_sources ws JOIN parking_lots p ON p.id = ws.parking_lot_id
    WHERE ws.relevance_score BETWEEN 60 AND 80 ORDER BY RANDOM() LIMIT 10
  ) UNION ALL SELECT * FROM (
    SELECT ws.id, ws.relevance_score, ws.source, ws.title, ws.content, p.name, p.address
    FROM web_sources ws JOIN parking_lots p ON p.id = ws.parking_lot_id
    WHERE ws.relevance_score >= 80 ORDER BY RANDOM() LIMIT 10
  )
`);

console.log(`\n🎯 매칭 답지 생성 (${isRemote ? "remote" : "local"}, ${samples.length}건)\n`);

const items = samples.map((s, i) =>
  `[${i + 1}] 주차장="${s.lot_name}" (${s.lot_addr.slice(0, 30)}) | 점수=${s.score} | 제목: ${s.title.slice(0, 65)} | 내용: ${(s.content || "").slice(0, 150)}`
).join("\n");

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
    system: `주차장-글 매칭 검증기입니다. 각 항목은 "이 글이 이 주차장에 관련있는지"를 판단합니다.

JSON 배열로 출력하세요:
[{"id": 번호, "relevant": true/false, "reason": "이유 10자"}]

판단 기준:
- relevant=true: 글이 해당 주차장을 직접 언급하거나, 해당 주차장의 주차 정보/경험을 담고 있음
- relevant=false: 글이 해당 주차장과 무관 (같은 동네일 뿐, 다른 장소 이야기, 부동산, 구인 등)
- 글 제목에 "XX 주차장 Top5"이고 매칭된 주차장명이 XX와 다르면 → 본문에 해당 주차장이 실제로 소개되는지 확인 필요 (제목만으로 false)`,
    messages: [{ role: "user", content: items }],
  }),
  signal: AbortSignal.timeout(60_000),
});

const data = (await res.json()) as { content: Array<{ text: string }> };
const text = data.content[0].text;
const arrMatch = text.match(/\[[\s\S]*\]/);
if (!arrMatch) { console.error("AI 응답 파싱 실패"); process.exit(1); }

const verdicts = JSON.parse(arrMatch[0]) as Array<{ id: number; relevant: boolean; reason: string }>;
const vMap = new Map(verdicts.map(v => [v.id, v]));

// ── 구 로직(DB 점수) vs 신 로직 비교 ──
let oldTp = 0, oldFp = 0, oldTn = 0, oldFn = 0;
let newTp = 0, newFp = 0, newTn = 0, newFn = 0;

for (let i = 0; i < samples.length; i++) {
  const s = samples[i];
  const v = vMap.get(i + 1) ?? { relevant: false, reason: "?" };

  // 구 로직 (DB에 저장된 score)
  const oldPass = s.score >= THRESHOLD;
  if (oldPass && v.relevant) oldTp++;
  else if (oldPass && !v.relevant) oldFp++;
  else if (!oldPass && !v.relevant) oldTn++;
  else oldFn++;

  // 신 로직 (개선된 scoreBlogRelevance)
  const newScore = scoreBlogRelevance(
    stripHtml(s.title), stripHtml(s.content || ""), s.lot_name, s.lot_addr,
  );
  const newPass = newScore >= THRESHOLD;
  if (newPass && v.relevant) newTp++;
  else if (newPass && !v.relevant) newFp++;
  else if (!newPass && !v.relevant) newTn++;
  else newFn++;

  const icon = v.relevant ? "✅" : "❌";
  const oldWarn = oldPass !== v.relevant ? "⚠️" : "  ";
  const newWarn = newPass !== v.relevant ? "⚠️" : "  ";
  const changed = s.score !== newScore ? `→${newScore}` : "";

  console.log(`${oldWarn}${newWarn} [${s.score.toString().padStart(3)}${changed.padEnd(4)}] ${icon} ${s.lot_name.slice(0, 18).padEnd(18)} ← ${s.title.slice(0, 40).padEnd(40)} | ${v.reason}`);
}

function printMatrix(label: string, tp: number, fp: number, fn: number, tn: number) {
  const prec = tp + fp > 0 ? (tp / (tp + fp) * 100) : 0;
  const rec = tp + fn > 0 ? (tp / (tp + fn) * 100) : 0;
  const f1 = prec + rec > 0 ? (2 * prec * rec / (prec + rec)) : 0;
  console.log(`  ${label}: TP=${tp} FP=${fp} FN=${fn} TN=${tn} | 정밀도=${prec.toFixed(0)}% 재현율=${rec.toFixed(0)}% F1=${f1.toFixed(0)}%`);
}

console.log(`\n━━━ threshold=${THRESHOLD} 기준 비교 ━━━`);
printMatrix("구 로직", oldTp, oldFp, oldFn, oldTn);
printMatrix("신 로직", newTp, newFp, newFn, newTn);
