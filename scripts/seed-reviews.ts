/**
 * 헬 주차장 Seed 리뷰 생성
 *
 * - curated 주차장에 대해 crawled_reviews(블로그 후기)를 분석
 * - Claude API로 후기에서 난이도 관련 정보를 추출하여 Seed 리뷰 생성
 * - reviews 테이블에 is_seed=1로 저장
 *
 * 사용법: bun run scripts/seed-reviews.ts
 */
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "fs";
import { execSync } from "child_process";
import { resolve } from "path";
import Anthropic from "@anthropic-ai/sdk";

// --- Config ---
const DELAY = 1000; // API 호출 간 딜레이 (ms)
const PROGRESS_JSON = resolve(import.meta.dir, "seed-review-progress.json");
const TMP_SQL = resolve(import.meta.dir, "../.tmp-seed.sql");

// --- Types ---
interface CuratedLot {
  id: string;
  name: string;
  address: string;
  curation_tag: string;
  curation_reason: string;
  blog_count: number;
}

interface BlogSnippet {
  title: string;
  content: string;
  source: string;
}

interface GeneratedReview {
  overallScore: number; // 1-5
  comment: string; // 200자 이내
}

interface Progress {
  completedIds: string[];
  generatedReviews: number;
  skippedNoBlogs: number;
  apiCalls: number;
  startedAt: string;
  lastUpdatedAt: string;
}

// --- Progress ---
function loadProgress(): Progress {
  if (existsSync(PROGRESS_JSON)) {
    return JSON.parse(readFileSync(PROGRESS_JSON, "utf-8"));
  }
  return {
    completedIds: [],
    generatedReviews: 0,
    skippedNoBlogs: 0,
    apiCalls: 0,
    startedAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
  };
}

function saveProgress(p: Progress) {
  p.lastUpdatedAt = new Date().toISOString();
  writeFileSync(PROGRESS_JSON, JSON.stringify(p, null, 2));
}

// --- Helpers ---
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function esc(s: string): string {
  return s.replace(/'/g, "''");
}

function queryDB(sql: string): any[] {
  const raw = execSync(
    `npx wrangler d1 execute parking-db --local --command "${sql.replace(/"/g, '\\"')}" --json`,
    { encoding: "utf-8", maxBuffer: 100 * 1024 * 1024 }
  );
  return JSON.parse(raw)[0]?.results ?? [];
}

function executeSQL(sql: string) {
  writeFileSync(TMP_SQL, sql);
  execSync(`npx wrangler d1 execute parking-db --local --file="${TMP_SQL}"`, {
    stdio: "pipe",
  });
}

// --- Claude API ---
async function generateSeedReview(
  client: Anthropic,
  lot: CuratedLot,
  blogs: BlogSnippet[]
): Promise<GeneratedReview | null> {
  const blogTexts = blogs
    .map((b, i) => `[후기 ${i + 1}] ${b.title}\n${b.content}`)
    .join("\n\n");

  const prompt = `주차장 정보:
- 이름: ${lot.name}
- 주소: ${lot.address}
- 태그: ${lot.curation_tag === "hell" ? "헬 주차장 (초보 주의)" : "초보 추천"}
- 큐레이션 사유: ${lot.curation_reason}

아래는 이 주차장에 대한 블로그/카페 후기입니다:

${blogTexts}

위 후기를 종합하여 초보운전자 관점의 주차장 난이도 리뷰를 작성해주세요.

응답 형식 (JSON만):
{
  "overallScore": (1-5 정수. 1=초보 비추, 5=초보 추천),
  "comment": "(200자 이내. 진입로, 주차면, 통로, 출차 등 초보자가 알아야 할 핵심 정보)"
}

규칙:
- 후기에 근거한 사실만 작성. 추측 금지.
- overallScore는 후기 내용 기반. hell 태그라도 후기에 "넓다"면 높은 점수 가능.
- 간결하고 실용적인 한국어로 작성.`;

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    messages: [{ role: "user", content: prompt }],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";

  // JSON 추출
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[0]);
    const score = Math.max(1, Math.min(5, Math.round(parsed.overallScore)));
    const comment = String(parsed.comment).slice(0, 200);
    return { overallScore: score, comment };
  } catch {
    return null;
  }
}

// --- Main ---
async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY가 .env에 설정되지 않았습니다.");
    process.exit(1);
  }

  const client = new Anthropic();
  const progress = loadProgress();
  const completedSet = new Set(progress.completedIds);

  // curated 주차장 중 아직 seed 리뷰가 없는 것
  console.log("큐레이션 주차장 조회 중...");
  const lots: CuratedLot[] = queryDB(`
    SELECT p.id, p.name, p.address, p.curation_tag, p.curation_reason,
      (SELECT COUNT(*) FROM crawled_reviews WHERE parking_lot_id = p.id AND relevance_score >= 40) as blog_count
    FROM parking_lots p
    WHERE p.is_curated = 1
      AND NOT EXISTS (SELECT 1 FROM reviews WHERE parking_lot_id = p.id AND is_seed = 1)
    ORDER BY blog_count DESC
  `);

  const remaining = lots.filter((l) => !completedSet.has(l.id));
  console.log(`대상: ${remaining.length}개 (블로그 후기 있는 것 우선)\n`);

  let processed = 0;

  for (const lot of remaining) {
    // 블로그 후기가 없으면 스킵 (추측 금지 원칙)
    if (lot.blog_count === 0) {
      progress.skippedNoBlogs++;
      completedSet.add(lot.id);
      progress.completedIds.push(lot.id);
      console.log(`  ⏭️ ${lot.name} — 블로그 후기 없음, 스킵`);
      continue;
    }

    // 블로그 후기 가져오기
    const blogs: BlogSnippet[] = queryDB(`
      SELECT title, content, source FROM crawled_reviews
      WHERE parking_lot_id = '${esc(lot.id)}' AND relevance_score >= 40
      ORDER BY relevance_score DESC LIMIT 5
    `);

    console.log(`  🔄 ${lot.name} (${lot.curation_tag}, 후기 ${blogs.length}건)`);

    try {
      const review = await generateSeedReview(client, lot, blogs);
      progress.apiCalls++;

      if (review) {
        const stmt = `INSERT INTO reviews (parking_lot_id, entry_score, space_score, passage_score, exit_score, overall_score, comment, is_seed) VALUES ('${esc(lot.id)}', ${review.overallScore}, ${review.overallScore}, ${review.overallScore}, ${review.overallScore}, ${review.overallScore}, '${esc(review.comment)}', 1);`;
        executeSQL(stmt);
        progress.generatedReviews++;
        console.log(`    ✅ 점수=${review.overallScore} "${review.comment.slice(0, 50)}..."`);
      } else {
        console.log(`    ⚠️ 리뷰 생성 실패 (파싱 오류)`);
      }
    } catch (err) {
      console.error(`    ❌ API 오류: ${(err as Error).message.slice(0, 80)}`);
    }

    completedSet.add(lot.id);
    progress.completedIds.push(lot.id);
    processed++;

    if (processed % 5 === 0) {
      saveProgress(progress);
    }

    await sleep(DELAY);
  }

  saveProgress(progress);
  if (existsSync(TMP_SQL)) unlinkSync(TMP_SQL);

  console.log(`\n✅ 완료!`);
  console.log(`  생성: ${progress.generatedReviews}건`);
  console.log(`  스킵(후기없음): ${progress.skippedNoBlogs}건`);
  console.log(`  API 호출: ${progress.apiCalls}회`);
}

main().catch((err) => {
  console.error("\n에러:", err.message);
  process.exit(1);
});
