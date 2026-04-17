/**
 * 타겟 주차장 집중 보강 — 검색 유입 상위 lot을 한 번에 강화
 *
 * 파이프라인 (lot 1개 단위):
 *   1. 네이버 블로그/카페 검색 (여러 쿼리) → web_sources 적재
 *   2. Haiku로 구조화 정보(운영시간·요금·주차면·전화) 추출 → parking_lots UPDATE
 *   3. web_sources + user_reviews로 AI 요약 생성 → parking_lot_stats.ai_summary UPSERT
 *
 * 사용법:
 *   bun run scripts/enrich-targeted.ts --lotIds=KA-1935812519,KA-381534316 --remote
 *   bun run scripts/enrich-targeted.ts --lotIds=... --remote --dry-run
 *
 * 환경변수: NAVER_CLIENT_ID, NAVER_CLIENT_SECRET, ANTHROPIC_API_KEY
 */
import { resolve } from "path";
import { writeFileSync } from "fs";
import { d1Query, d1ExecFile, isRemote } from "./lib/d1";
import { esc } from "./lib/sql-flush";

// ── CLI ──
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const lotIdsArg = args.find((a) => a.startsWith("--lotIds="))?.split("=")[1];
if (!lotIdsArg) {
  console.error("--lotIds=id1,id2 필수");
  process.exit(1);
}
const LOT_IDS = lotIdsArg.split(",").map((s) => s.trim()).filter(Boolean);

// ── 환경 ──
const NAVER_ID = process.env.NAVER_CLIENT_ID;
const NAVER_SECRET = process.env.NAVER_CLIENT_SECRET;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash-lite";
if (!NAVER_ID || !NAVER_SECRET) {
  console.error("NAVER_CLIENT_ID, NAVER_CLIENT_SECRET 필요");
  process.exit(1);
}
if (!GEMINI_KEY) {
  console.error("GEMINI_API_KEY 필요");
  process.exit(1);
}

// ── 타입 ──
interface Lot {
  id: string;
  name: string;
  address: string;
}

interface NaverItem {
  title: string;
  description: string;
  link: string;
  bloggername?: string;
  postdate?: string;
  cafename?: string;
}

interface Snippet {
  source: "naver_blog" | "naver_cafe";
  title: string;
  content: string;
  url: string;
  author: string;
  publishedAt: string | null;
}

interface Extracted {
  weekday_start: string | null;
  weekday_end: string | null;
  saturday_start: string | null;
  saturday_end: string | null;
  holiday_start: string | null;
  holiday_end: string | null;
  is_free: number | null;
  base_time: number | null;
  base_fee: number | null;
  extra_time: number | null;
  extra_fee: number | null;
  daily_max: number | null;
  phone: string | null;
  total_spaces: number | null;
  notes: string | null;
}

// ── Naver search ──
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&#39;/g, "'")
    .trim();
}

async function naverSearch(
  kind: "blog" | "cafearticle",
  query: string,
  display = 10,
): Promise<NaverItem[]> {
  const params = new URLSearchParams({ query, display: String(display), sort: "sim" });
  const res = await fetch(`https://openapi.naver.com/v1/search/${kind}.json?${params}`, {
    headers: {
      "X-Naver-Client-Id": NAVER_ID!,
      "X-Naver-Client-Secret": NAVER_SECRET!,
    },
  });
  if (!res.ok) {
    console.warn(`  Naver ${kind} API ${res.status}: ${await res.text()}`);
    return [];
  }
  const data = (await res.json()) as { items: NaverItem[] };
  return data.items ?? [];
}

// ── 수집 ──
async function collectSnippets(lot: Lot): Promise<Snippet[]> {
  const queries = [
    `${lot.name}`,
    `${lot.name} 주차`,
    `${lot.name} 운영시간 요금`,
    `${lot.name} 후기`,
  ];

  const seen = new Set<string>();
  const snippets: Snippet[] = [];

  for (const q of queries) {
    const [blogs, cafes] = await Promise.all([
      naverSearch("blog", q, 10),
      naverSearch("cafearticle", q, 5),
    ]);
    for (const b of blogs) {
      const url = b.link;
      if (seen.has(url)) continue;
      seen.add(url);
      snippets.push({
        source: "naver_blog",
        title: stripHtml(b.title),
        content: stripHtml(b.description),
        url,
        author: b.bloggername ?? "",
        publishedAt: b.postdate ? b.postdate.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3") : null,
      });
    }
    for (const c of cafes) {
      const url = c.link;
      if (seen.has(url)) continue;
      seen.add(url);
      snippets.push({
        source: "naver_cafe",
        title: stripHtml(c.title),
        content: stripHtml(c.description),
        url,
        author: c.cafename ?? "",
        publishedAt: null,
      });
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return snippets;
}

// ── Gemini 호출 (재시도 + 모델 폴백) ──
const MODEL_CHAIN = [GEMINI_MODEL, "gemini-flash-lite-latest", "gemini-flash-latest"];

async function tryCall(
  model: string,
  system: string,
  user: string,
  maxTokens: number,
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0.3 },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    const err: Error & { status?: number } = new Error(`Gemini(${model}) ${res.status}: ${body.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
}

async function callLLM(system: string, user: string, maxTokens = 500): Promise<string> {
  let lastErr: Error | null = null;
  for (const model of MODEL_CHAIN) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await tryCall(model, system, user, maxTokens);
      } catch (e) {
        lastErr = e as Error;
        const status = (e as { status?: number }).status;
        // 503/429는 재시도, 나머지는 다음 모델로
        if (status === 503 || status === 429) {
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
          continue;
        }
        break; // 다음 모델로
      }
    }
    console.warn(`  ⚠ ${model} 실패, 다음 모델 시도: ${lastErr?.message?.slice(0, 100)}`);
  }
  throw lastErr ?? new Error("Gemini 모든 모델 실패");
}

// ── 구조화 정보 추출 ──
const EXTRACT_SYSTEM = `주차장 관련 블로그/카페 검색 결과에서 기본정보를 추출하세요.
반드시 JSON으로만 응답. 확인할 수 없는 항목은 null.

응답 형식:
{
  "weekday_start": "HH:MM" 또는 null,
  "weekday_end": "HH:MM" 또는 null,
  "saturday_start": "HH:MM" 또는 null,
  "saturday_end": "HH:MM" 또는 null,
  "holiday_start": "HH:MM" 또는 null,
  "holiday_end": "HH:MM" 또는 null,
  "is_free": 1(무료) 또는 0(유료) 또는 null,
  "base_time": 기본시간(분) 또는 null,
  "base_fee": 기본요금(원) 또는 null,
  "extra_time": 추가단위시간(분) 또는 null,
  "extra_fee": 추가단위요금(원) 또는 null,
  "daily_max": 1일최대요금(원) 또는 null,
  "phone": "전화번호" 또는 null,
  "total_spaces": 총주차면수 또는 null,
  "notes": "특기사항(공사중·구매액 연동 무료·폐쇄 등 중요 정보만 1문장)" 또는 null
}

규칙:
- 24시간 운영이면 "00:00"~"23:59"
- "무료"라고 명시되고 여러 블로그가 동의할 때만 is_free=1, 불확실하면 null
- 숫자는 콤마 제거한 정수
- 출처가 1개 뿐인 정보는 낮은 신뢰도라 null 선호`;

async function extractStructured(lot: Lot, snippets: Snippet[]): Promise<Extracted | null> {
  if (snippets.length === 0) return null;
  const context = snippets
    .slice(0, 25)
    .map((s, i) => `[${i + 1}] ${s.title}\n${s.content}`)
    .join("\n\n");
  const user = `주차장명: ${lot.name}\n주소: ${lot.address}\n\n검색 결과:\n${context}`;
  const text = await callLLM(EXTRACT_SYSTEM, user, 800);
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as Extracted;
  } catch {
    console.warn("  JSON 파싱 실패:", text.slice(0, 200));
    return null;
  }
}

// ── AI 요약 생성 ──
const SUMMARY_SYSTEM = `주차장 정보 큐레이터. 블로그·카페·리뷰를 읽고 실제 이용자가 알고 싶은 특징을 2~3문장(120~180자)으로 요약.

규칙:
- 진입 난이도 / 주차면 / 통로 / 출차 / 요금·무료 / 혼잡 시간대 중심
- "AI가 분석했다" "데이터에 따르면" 같은 메타 표현 금지, 사람이 쓴 것처럼 자연스럽게
- **반드시 경어체(~습니다, ~합니다, ~입니다)로만 작성**. 평서체(~다, ~이다) 금지
- 이모지, 마크다운 금지
- 모순 의견은 "대체로 ~하지만 ~도 있습니다"
- 근거 빈약하면 "이용자 후기가 적어 단정하기 어렵습니다"라고 솔직히
- 서두/꼬리말 없이 요약문만 출력`;

async function generateSummary(
  lot: Lot,
  snippets: Snippet[],
  reviews: { overall_score: number; comment: string | null }[],
): Promise<string | null> {
  if (snippets.length === 0 && reviews.length === 0) return null;
  const blogBlock = snippets.length > 0
    ? snippets.slice(0, 20).map((s, i) => `[${i + 1}] ${s.title}\n${s.content.slice(0, 300)}`).join("\n\n")
    : "(블로그 언급 없음)";
  const reviewBlock = reviews.length > 0
    ? reviews.map((r, i) => `[R${i + 1}] 종합 ${r.overall_score}/5 — ${r.comment?.slice(0, 200) ?? "(코멘트 없음)"}`).join("\n")
    : "(사용자 리뷰 없음)";
  const user = `대상 주차장: ${lot.name}\n주소: ${lot.address}\n\n블로그/카페 (${snippets.length}건):\n${blogBlock}\n\n사용자 리뷰 (${reviews.length}건):\n${reviewBlock}\n\n요약:`;
  return await callLLM(SUMMARY_SYSTEM, user, 500);
}

// ── DB 작업 ──
function fetchLot(id: string): Lot | null {
  const rows = d1Query<Lot>(
    `SELECT id, name, address FROM parking_lots WHERE id = '${esc(id)}'`,
  );
  return rows[0] ?? null;
}

function fetchReviews(id: string) {
  return d1Query<{ overall_score: number; comment: string | null }>(
    `SELECT overall_score, comment FROM user_reviews
     WHERE parking_lot_id = '${esc(id)}' ORDER BY created_at DESC LIMIT 30`,
  );
}

function fetchExistingUrls(id: string): Set<string> {
  const rows = d1Query<{ source_url: string }>(
    `SELECT source_url FROM web_sources WHERE parking_lot_id = '${esc(id)}'`,
  );
  return new Set(rows.map((r) => r.source_url));
}

function buildWebSourceInsert(lotId: string, s: Snippet): string {
  const sourceId = `${s.source}:${Buffer.from(s.url).toString("base64").slice(0, 40)}`;
  const publishedAt = s.publishedAt ? `'${esc(s.publishedAt)}'` : "NULL";
  return `INSERT INTO web_sources (parking_lot_id, source, source_id, title, content, source_url, author, published_at, relevance_score)
VALUES ('${esc(lotId)}', '${s.source}', '${esc(sourceId)}', '${esc(s.title)}', '${esc(s.content)}', '${esc(s.url)}', '${esc(s.author)}', ${publishedAt}, 50);`;
}

function buildLotUpdate(id: string, info: Extracted): string | null {
  const sets: string[] = [];
  if (info.weekday_start) sets.push(`weekday_start = '${esc(info.weekday_start)}'`);
  if (info.weekday_end) sets.push(`weekday_end = '${esc(info.weekday_end)}'`);
  if (info.saturday_start) sets.push(`saturday_start = '${esc(info.saturday_start)}'`);
  if (info.saturday_end) sets.push(`saturday_end = '${esc(info.saturday_end)}'`);
  if (info.holiday_start) sets.push(`holiday_start = '${esc(info.holiday_start)}'`);
  if (info.holiday_end) sets.push(`holiday_end = '${esc(info.holiday_end)}'`);
  if (info.is_free !== null) sets.push(`is_free = ${info.is_free}`);
  if (info.base_time !== null) sets.push(`base_time = ${info.base_time}`);
  if (info.base_fee !== null) sets.push(`base_fee = ${info.base_fee}`);
  if (info.extra_time !== null) sets.push(`extra_time = ${info.extra_time}`);
  if (info.extra_fee !== null) sets.push(`extra_fee = ${info.extra_fee}`);
  if (info.daily_max !== null) sets.push(`daily_max = ${info.daily_max}`);
  if (info.phone) sets.push(`phone = '${esc(info.phone)}'`);
  if (info.total_spaces !== null && info.total_spaces > 0) sets.push(`total_spaces = ${info.total_spaces}`);
  if (info.notes) sets.push(`notes = '${esc(info.notes)}'`);
  if (sets.length === 0) return null;
  sets.push("verified_source = 'blog_ai_targeted'");
  sets.push("verified_at = datetime('now')");
  sets.push("updated_at = datetime('now')");
  return `UPDATE parking_lots SET ${sets.join(", ")} WHERE id = '${esc(id)}';`;
}

function buildSummaryUpsert(lotId: string, summary: string): string {
  return `INSERT INTO parking_lot_stats (parking_lot_id, ai_summary, ai_summary_updated_at)
VALUES ('${esc(lotId)}', '${esc(summary)}', datetime('now'))
ON CONFLICT(parking_lot_id) DO UPDATE SET
  ai_summary = excluded.ai_summary,
  ai_summary_updated_at = excluded.ai_summary_updated_at;`;
}

// ── Main ──
async function main() {
  console.log(`=== 타겟 보강 === (${DRY_RUN ? "DRY-RUN" : isRemote ? "REMOTE" : "LOCAL"})`);
  console.log(`대상 ${LOT_IDS.length}개: ${LOT_IDS.join(", ")}\n`);

  for (const lotId of LOT_IDS) {
    const lot = fetchLot(lotId);
    if (!lot) {
      console.warn(`✗ ${lotId}: 주차장 없음, 건너뜀\n`);
      continue;
    }
    console.log(`▶ ${lot.name} (${lot.id})`);
    console.log(`  주소: ${lot.address}`);

    // 1. 스니펫 수집
    console.log(`  ▸ Naver 블로그/카페 검색...`);
    const snippets = await collectSnippets(lot);
    console.log(`  ▸ 수집: ${snippets.length}건`);

    const existingUrls = fetchExistingUrls(lot.id);
    const newSnippets = snippets.filter((s) => !existingUrls.has(s.url));
    console.log(`  ▸ 신규 (중복 제외): ${newSnippets.length}건`);

    // 2. 구조화 추출
    console.log(`  ▸ Haiku 구조화 추출...`);
    const info = await extractStructured(lot, snippets);
    if (info) {
      const details: string[] = [];
      if (info.weekday_start) details.push(`운영 ${info.weekday_start}~${info.weekday_end}`);
      if (info.is_free === 1) details.push("무료");
      else if (info.base_fee !== null) details.push(`${info.base_time}분 ${info.base_fee}원`);
      if (info.total_spaces) details.push(`${info.total_spaces}면`);
      if (info.phone) details.push(`tel ${info.phone}`);
      if (info.notes) details.push(`note: ${info.notes}`);
      console.log(`  ▸ 추출: ${details.join(" / ") || "(필드 없음)"}`);
    } else {
      console.log(`  ▸ 추출 실패`);
    }

    // 3. 요약 생성
    console.log(`  ▸ 요약 생성...`);
    const reviews = fetchReviews(lot.id);
    const summary = await generateSummary(lot, snippets, reviews);
    if (summary) console.log(`  ▸ 요약:\n    ${summary.replace(/\n/g, "\n    ")}`);
    else console.log(`  ▸ 요약: (근거 부족)`);

    // 4. DB 반영
    if (DRY_RUN) {
      console.log(`  (dry-run: DB 미반영)\n`);
      continue;
    }

    const stmts: string[] = [];
    for (const s of newSnippets) stmts.push(buildWebSourceInsert(lot.id, s));
    const lotUpdate = info ? buildLotUpdate(lot.id, info) : null;
    if (lotUpdate) stmts.push(lotUpdate);
    if (summary) stmts.push(buildSummaryUpsert(lot.id, summary));

    if (stmts.length === 0) {
      console.log(`  (쓸 내용 없음)\n`);
      continue;
    }

    console.log(`  ▸ DB 반영 ${stmts.length}건 (file-based)...`);
    const tmpFile = resolve(import.meta.dir, `../.tmp-enrich-${lot.id}.sql`);
    writeFileSync(tmpFile, stmts.join("\n") + "\n", "utf-8");
    try {
      d1ExecFile(tmpFile);
      console.log(`  ✓ 완료\n`);
    } catch (e) {
      console.warn(`  ✗ 반영 실패:`, (e as Error).message.slice(0, 300));
    }
  }

  console.log("===== 끝 =====");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
