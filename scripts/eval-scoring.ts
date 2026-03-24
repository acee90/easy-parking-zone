/**
 * 스코어링 로직 평가 스크립트
 *
 * scripts/answer-key.json (고정 답지)를 기준으로
 * scoreBlogRelevance 함수의 정밀도/재현율/F1을 측정.
 *
 * Usage: bun run scripts/eval-scoring.ts [--verbose]
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { scoreBlogRelevance, stripHtml } from "../src/server/crawlers/lib/scoring";

const verbose = process.argv.includes("--verbose");
const THRESHOLD = 60;

interface Entry {
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

const answerKey: Entry[] = JSON.parse(
  readFileSync(resolve(import.meta.dir, "answer-key.json"), "utf-8"),
);

console.log(`\n📏 스코어링 평가 (답지 ${answerKey.length}건, threshold=${THRESHOLD})\n`);

let oldTp = 0, oldFp = 0, oldTn = 0, oldFn = 0;
let newTp = 0, newFp = 0, newTn = 0, newFn = 0;

const mismatches: Array<{ type: string; entry: Entry; oldScore: number; newScore: number }> = [];

for (const e of answerKey) {
  const oldPass = e.score >= THRESHOLD;
  const newScore = scoreBlogRelevance(
    stripHtml(e.title), stripHtml(e.content || ""), e.lot_name, e.lot_addr,
  );
  const newPass = newScore >= THRESHOLD;

  // 구 로직
  if (oldPass && e.relevant) oldTp++;
  else if (oldPass && !e.relevant) oldFp++;
  else if (!oldPass && !e.relevant) oldTn++;
  else oldFn++;

  // 신 로직
  if (newPass && e.relevant) newTp++;
  else if (newPass && !e.relevant) newFp++;
  else if (!newPass && !e.relevant) newTn++;
  else newFn++;

  // 불일치 수집
  if (newPass !== e.relevant) {
    const type = newPass ? "FP" : "FN";
    mismatches.push({ type, entry: e, oldScore: e.score, newScore });
  }
}

function metrics(tp: number, fp: number, fn: number, tn: number) {
  const prec = tp + fp > 0 ? tp / (tp + fp) : 0;
  const rec = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = prec + rec > 0 ? 2 * prec * rec / (prec + rec) : 0;
  return { prec, rec, f1, tp, fp, fn, tn };
}

const oldM = metrics(oldTp, oldFp, oldFn, oldTn);
const newM = metrics(newTp, newFp, newFn, newTn);

function fmt(m: ReturnType<typeof metrics>, label: string) {
  const p = (m.prec * 100).toFixed(0);
  const r = (m.rec * 100).toFixed(0);
  const f = (m.f1 * 100).toFixed(0);
  console.log(`  ${label}: TP=${m.tp} FP=${m.fp} FN=${m.fn} TN=${m.tn} | 정밀도=${p}% 재현율=${r}% F1=${f}%`);
}

fmt(oldM, "구 로직 (DB score)");
fmt(newM, "신 로직 (개선)    ");

const f1Diff = ((newM.f1 - oldM.f1) * 100).toFixed(1);
console.log(`\n  F1 변화: ${Number(f1Diff) >= 0 ? "+" : ""}${f1Diff}%p`);

// 불일치 상세
if (verbose || mismatches.length <= 30) {
  console.log(`\n━━━ 신 로직 불일치 ${mismatches.length}건 ━━━`);

  const fps = mismatches.filter(m => m.type === "FP");
  const fns = mismatches.filter(m => m.type === "FN");

  if (fps.length > 0) {
    console.log(`\n  FP (오답 통과 — ${fps.length}건):`);
    for (const m of fps.slice(0, 15)) {
      console.log(`    [${m.oldScore}→${m.newScore}] ${m.entry.lot_name.slice(0, 18)} ← ${m.entry.title.slice(0, 40)} | ${m.entry.reason}`);
    }
  }

  if (fns.length > 0) {
    console.log(`\n  FN (놓침 — ${fns.length}건):`);
    for (const m of fns.slice(0, 15)) {
      console.log(`    [${m.oldScore}→${m.newScore}] ${m.entry.lot_name.slice(0, 18)} ← ${m.entry.title.slice(0, 40)} | ${m.entry.reason}`);
    }
  }
}

console.log();
