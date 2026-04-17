/**
 * 주차장 AI 요약 생성 — web_sources + user_reviews를 한 문단으로 압축
 *
 * Usage:
 *   # 단일 주차장
 *   bun run scripts/generate-lot-summary.ts --lotId=KA-1234567890
 *   # 키워드로 매칭 (LIKE 검색, searchParkingLots와 동일 로직)
 *   bun run scripts/generate-lot-summary.ts --keyword="스타필드 위례"
 *   # 드라이런 (DB 저장 안함, 결과만 출력)
 *   bun run scripts/generate-lot-summary.ts --lotId=... --dry-run
 *   # 리모트 D1
 *   bun run scripts/generate-lot-summary.ts --keyword="기지제" --remote
 *
 * 환경변수: ANTHROPIC_API_KEY
 *
 * 출력: parking_lot_stats.ai_summary (한 문단, 2~3줄)
 */
import { d1Query, d1Execute } from "./lib/d1";
import { esc } from "./lib/sql-flush";

// ── CLI ──
const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");
const lotIdArg = args.find((a) => a.startsWith("--lotId="))?.split("=")[1];
const keywordArg = args.find((a) => a.startsWith("--keyword="))?.split("=")[1];

if (!lotIdArg && !keywordArg) {
  console.error("--lotId=... 또는 --keyword=... 필수");
  process.exit(1);
}

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY && !isDryRun) {
  console.error("ANTHROPIC_API_KEY 환경변수 필요 (--dry-run은 API 없이 실행 가능)");
  process.exit(1);
}

// ── 대상 주차장 해결 ──
interface LotRow {
  id: string;
  name: string;
  address: string;
}

function resolveLots(): LotRow[] {
  if (lotIdArg) {
    return d1Query<LotRow>(
      `SELECT id, name, address FROM parking_lots WHERE id = '${esc(lotIdArg)}'`,
    );
  }
  const words = keywordArg!.trim().split(/\s+/).filter((w) => w.length >= 1);
  const conds = words.map((w) => {
    const like = `%${esc(w)}%`;
    return `(name LIKE '${like}' OR address LIKE '${like}' OR poi_tags LIKE '${like}')`;
  }).join(" AND ");
  return d1Query<LotRow>(
    `SELECT id, name, address FROM parking_lots WHERE ${conds} LIMIT 20`,
  );
}

// ── 소스 수집 ──
interface SourceRow {
  title: string;
  content: string;
  source: string;
  source_url: string;
}

interface ReviewRow {
  overall_score: number;
  entry_score: number;
  space_score: number;
  passage_score: number;
  exit_score: number;
  comment: string | null;
}

function fetchSources(lotId: string): { web: SourceRow[]; reviews: ReviewRow[] } {
  const web = d1Query<SourceRow>(
    `SELECT title, content, source, source_url
     FROM web_sources
     WHERE parking_lot_id = '${esc(lotId)}'
     ORDER BY relevance_score DESC
     LIMIT 30`,
  );
  const reviews = d1Query<ReviewRow>(
    `SELECT overall_score, entry_score, space_score, passage_score, exit_score, comment
     FROM user_reviews
     WHERE parking_lot_id = '${esc(lotId)}'
     ORDER BY created_at DESC
     LIMIT 30`,
  );
  return { web, reviews };
}

// ── 프롬프트 ──
function buildPrompt(lot: LotRow, web: SourceRow[], reviews: ReviewRow[]): string {
  const webBlock = web.length > 0
    ? web.map((s, i) => `[${i + 1}] ${s.title}\n${s.content.slice(0, 400)}`).join("\n\n")
    : "(블로그·커뮤니티 언급 없음)";
  const reviewBlock = reviews.length > 0
    ? reviews.map((r, i) => {
        const c = r.comment ? `"${r.comment.slice(0, 200)}"` : "(코멘트 없음)";
        return `[R${i + 1}] 종합 ${r.overall_score}/5 · 진입 ${r.entry_score} · 주차면 ${r.space_score} · 통로 ${r.passage_score} · 출차 ${r.exit_score} — ${c}`;
      }).join("\n")
    : "(사용자 리뷰 없음)";

  return `당신은 주차장 정보 큐레이터입니다. 아래 블로그 글·커뮤니티 글·사용자 리뷰를 읽고, 이 주차장의 특징을 2~3문장(약 120~180자)으로 요약하세요.

규칙:
- 진입 난이도, 주차면 넓이, 통로/출차, 요금·무료 여부, 혼잡 시간대 등 실제 이용자가 알고 싶은 포인트 위주로.
- "AI가 분석했다" "데이터에 따르면" 같은 메타 표현 금지. 사람이 쓴 것처럼 자연스럽게.
- 과장, 이모지, 마크다운 금지.
- **반드시 경어체(~습니다, ~합니다, ~입니다)로만 작성**. 평서체(~다, ~이다) 금지.
- 모순되는 의견이 있으면 "대체로 ~하지만 ~라는 의견도 있습니다" 식으로 균형 있게.
- 근거가 빈약하면 "이용자 후기가 적어 단정하기 어렵습니다"라고 솔직히.

대상 주차장:
- 이름: ${lot.name}
- 주소: ${lot.address}

블로그·커뮤니티 (상위 ${web.length}건):
${webBlock}

사용자 리뷰 (최근 ${reviews.length}건):
${reviewBlock}

요약 (2~3문장만 출력, 서두·꼬리말 없이):`;
}

// ── Claude 호출 ──
async function callClaude(prompt: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": API_KEY!,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { content: Array<{ text: string }> };
  return json.content[0]?.text?.trim() ?? "";
}

// ── Main ──
async function main() {
  const lots = resolveLots();
  if (lots.length === 0) {
    console.error("매칭된 주차장 없음");
    process.exit(1);
  }
  console.log(`대상 ${lots.length}개: ${lots.map((l) => `${l.name} (${l.id})`).join(", ")}`);

  for (const lot of lots) {
    const { web, reviews } = fetchSources(lot.id);
    console.log(`\n▶ ${lot.name} — web ${web.length}건, review ${reviews.length}건`);

    if (web.length + reviews.length === 0) {
      console.log("  근거 데이터 없음, 건너뜀");
      continue;
    }

    const prompt = buildPrompt(lot, web, reviews);

    if (isDryRun) {
      console.log("  [dry-run] 프롬프트 길이:", prompt.length);
      console.log("  샘플:", prompt.slice(0, 200), "...");
      continue;
    }

    const summary = await callClaude(prompt);
    console.log("  요약:", summary);

    // parking_lot_stats row가 없으면 INSERT, 있으면 UPDATE
    d1Execute(
      `INSERT INTO parking_lot_stats (parking_lot_id, ai_summary, ai_summary_updated_at)
       VALUES ('${esc(lot.id)}', '${esc(summary)}', datetime('now'))
       ON CONFLICT(parking_lot_id) DO UPDATE SET
         ai_summary = excluded.ai_summary,
         ai_summary_updated_at = excluded.ai_summary_updated_at`,
    );
  }

  console.log("\n완료");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
