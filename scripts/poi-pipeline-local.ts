/**
 * POI 파이프라인 v3 — 로컬 SQLite 직접 사용 (고속)
 *
 * Usage:
 *   bun run scripts/poi-pipeline-local.ts --region 안양
 *   bun run scripts/poi-pipeline-local.ts --region all   # 전체
 */
import { Database } from "bun:sqlite";
import Anthropic from "@anthropic-ai/sdk";
import { writeFileSync, existsSync, readFileSync } from "fs";
import { resolve } from "path";

const client = new Anthropic();
const DIR = resolve(import.meta.dir);
const DB_PATH = resolve(DIR, "..", "local-parking.db");
const db = new Database(DB_PATH);

const REGION = process.argv.find((_, i, arr) => arr[i - 1] === "--region") ?? "";
if (!REGION) {
  console.error("Usage: bun run scripts/poi-pipeline-local.ts --region <지역명|all>");
  process.exit(1);
}

const FETCH_DELAY = 300;
const AI_DELAY = 50;
const AI_CONCURRENCY = 10;
const NEARBY_RADIUS_KM = 5;

// ─── 타입 ──────────────────────────────────────────────
interface SourceRow {
  id: number;
  source: string;
  title: string;
  content: string;
  source_url: string;
  parking_lot_id: string;
  lot_name: string;
  lot_lat: number;
  lot_lng: number;
}

interface ParkingLot {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
}

// ─── 원문 수집 ──────────────────────────────────────────
function htmlToText(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function toBlogContentUrl(url: string): string {
  const match = url.match(/blog\.naver\.com\/([^/]+)\/(\d+)/);
  if (match) {
    return `https://blog.naver.com/PostView.naver?blogId=${match[1]}&logNo=${match[2]}&directAccess=false`;
  }
  return url;
}

async function fetchBlogFullText(url: string): Promise<string> {
  const contentUrl = toBlogContentUrl(url);
  const res = await fetch(contentUrl, {
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();

  const containerStart = html.indexOf('class="se-main-container"');
  if (containerStart !== -1) {
    const after = html.slice(containerStart);
    const ends = [
      after.indexOf('class="se-viewer-footer"'),
      after.indexOf('class="comment'),
      after.indexOf("</main>"),
      after.indexOf('id="printPost1"'),
    ].filter((i) => i > 0);
    const endIdx = ends.length > 0 ? Math.min(...ends) : after.length;
    return htmlToText(after.slice(0, endIdx));
  }

  const postViewStart = html.indexOf('id="post-view');
  if (postViewStart !== -1) {
    const after = html.slice(postViewStart);
    const endIdx = after.indexOf('class="comment');
    return htmlToText(after.slice(0, endIdx > 0 ? endIdx : after.length));
  }

  const bodyMatch = html.match(/<body[\s\S]*<\/body>/i);
  return htmlToText(bodyMatch?.[0] ?? html);
}

// ─── 필터링 (v3) ────────────────────────────────────────
const PARKING_KEYWORDS = [
  "주차", "parking", "주차장", "주차비", "주차요금", "주차면", "주차칸",
  "발렛", "기계식", "자주식", "무료주차", "유료주차", "주차타워",
];

function applyFilter(text: string, textLength: number, nearbyCount: number): { passed: boolean; removedBy: string | null } {
  if (textLength < 100) return { passed: false, removedBy: "tooShort" };
  const lower = text.toLowerCase();
  if (!PARKING_KEYWORDS.some((kw) => lower.includes(kw))) return { passed: false, removedBy: "noParkingKeyword" };
  if (nearbyCount < 1) return { passed: false, removedBy: "noNearbyLots" };
  return { passed: true, removedBy: null };
}

// ─── AI 매칭 ────────────────────────────────────────────
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
    { "lotId": "주차장 ID", "lotName": "주차장 이름", "confidence": "high" | "medium" | "low", "reason": "선택 이유 (1줄)" }
  ]
}

매칭되는 주차장이 없으면 빈 배열: {"matches": []}`;

interface AiMatch {
  lotId: string;
  lotName: string;
  confidence: "high" | "medium" | "low";
  reason: string;
}

async function aiMatch(text: string, nearbyLots: ParkingLot[]): Promise<AiMatch[]> {
  const truncated = text.slice(0, 2000);
  const lotList = nearbyLots
    .slice(0, 30)
    .map((l) => `- ID: ${l.id} | 이름: ${l.name} | 주소: ${l.address}`)
    .join("\n");

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 500,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `## 본문 (발췌)\n${truncated}\n\n## 주변 주차장 후보 (${nearbyLots.length}개 중 상위 30개)\n${lotList}\n\n이 글이 어떤 주차장에 대해 이야기하고 있나요?`,
      },
    ],
  });

  const respText = response.content[0].type === "text" ? response.content[0].text : "";
  const jsonMatch = respText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return [];
  try {
    return JSON.parse(jsonMatch[0]).matches ?? [];
  } catch {
    const retry = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `## 본문 (발췌)\n${truncated}\n\n## 주변 주차장 후보 (${nearbyLots.length}개 중 상위 30개)\n${lotList}\n\n이 글이 어떤 주차장에 대해 이야기하고 있나요? 반드시 유효한 JSON으로 응답하세요.`,
        },
      ],
    });
    const retryText = retry.content[0].type === "text" ? retry.content[0].text : "";
    const retryJson = retryText.match(/\{[\s\S]*\}/);
    if (!retryJson) return [];
    return JSON.parse(retryJson[0]).matches ?? [];
  }
}

// ─── Haversine ──────────────────────────────────────────
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Prepared Statements ────────────────────────────────
const updateStmt = db.prepare(
  "UPDATE web_sources SET full_text = ?1, full_text_length = ?2, filter_passed = ?3, filter_removed_by = ?4 WHERE id = ?5"
);
const insertMatchStmt = db.prepare(
  "INSERT OR IGNORE INTO web_source_ai_matches (web_source_id, parking_lot_id, confidence, reason) VALUES (?1, ?2, ?3, ?4)"
);

// ─── 지역 처리 ─────────────────────────────────────────
async function processRegion(region: string) {
  console.log(`\n━━━ [${region}] 시작 ━━━`);

  const CHECKPOINT_FILE = resolve(DIR, `poi-local-${region}-checkpoint.json`);
  let checkpoint = { phase: "fetch" as "fetch" | "ai" | "done", lastId: 0 };
  if (existsSync(CHECKPOINT_FILE)) {
    checkpoint = JSON.parse(readFileSync(CHECKPOINT_FILE, "utf-8"));
  }
  if (checkpoint.phase === "done") {
    console.log(`[${region}] 이미 완료됨 — 스킵`);
    return;
  }

  // 1. 데이터 로드 (fetch 필요한 건만)
  const fetchRows = db.query<SourceRow, []>(
    `SELECT ws.id, ws.source, ws.title, ws.content, ws.source_url, ws.parking_lot_id, p.name as lot_name, p.lat as lot_lat, p.lng as lot_lng FROM web_sources ws JOIN parking_lots p ON p.id = ws.parking_lot_id WHERE p.address LIKE '%${region}%' AND ws.source != 'naver_cafe' AND ws.full_text IS NULL ORDER BY ws.id`
  ).all();
  // 전체 건수 (이미 처리된 것 포함)
  const totalCount = db.query<{ cnt: number }, []>(
    `SELECT count(*) as cnt FROM web_sources ws JOIN parking_lots p ON p.id = ws.parking_lot_id WHERE p.address LIKE '%${region}%' AND ws.source != 'naver_cafe'`
  ).get();
  console.log(`[${region}] web_sources: ${totalCount?.cnt ?? 0}건 (미처리: ${fetchRows.length}건)`);

  if (fetchRows.length === 0 && checkpoint.phase !== "ai") {
    console.log(`[${region}] fetch 완료 — AI 매칭으로 이동`);
    checkpoint = { phase: "ai", lastId: 0 };
  }

  // 주차장 전체 로드 (첫 지역에서만)
  const allLots = db.query<ParkingLot, []>("SELECT id, name, address, lat, lng FROM parking_lots").all();

  // 2. 원문 수집
  if (checkpoint.phase === "fetch" && fetchRows.length > 0) {
    const pending = fetchRows.filter((r) => r.id > checkpoint.lastId);
    console.log(`[${region}] 원문 수집: ${pending.length}건`);

    let fetchOk = 0, fetchFail = 0;
    const txn = db.transaction(() => {
      // placeholder — 실제로는 아래에서 하나씩 처리
    });

    for (let i = 0; i < pending.length; i++) {
      const r = pending[i];
      if (i % 50 === 0) process.stdout.write(`\r[${region}] fetch ${i}/${pending.length}`);

      let fullText: string;
      try {
        if (r.source === "youtube_comment" || r.source === "naver_place" || r.source === "poi") {
          fullText = r.content;
        } else {
          fullText = await fetchBlogFullText(r.source_url);
        }
        fetchOk++;
      } catch {
        fullText = r.content;
        fetchFail++;
      }

      const textLength = fullText.length;
      const nearbyCount = allLots.filter(
        (l) => haversineKm(r.lot_lat, r.lot_lng, l.lat, l.lng) <= NEARBY_RADIUS_KM
      ).length;

      const filter = applyFilter(fullText, textLength, nearbyCount);

      // 로컬 DB 즉시 저장 (prepared statement — 초고속)
      updateStmt.run(fullText.slice(0, 5000), textLength, filter.passed ? 1 : 0, filter.removedBy, r.id);

      if (r.source === "naver_blog") {
        await new Promise((r) => setTimeout(r, FETCH_DELAY));
      }
    }

    checkpoint = { phase: "ai", lastId: 0 };
    writeFileSync(CHECKPOINT_FILE, JSON.stringify(checkpoint));

    const passed = db.query<{ cnt: number }, [string]>(
      `SELECT count(*) as cnt FROM web_sources ws JOIN parking_lots p ON p.id = ws.parking_lot_id WHERE p.address LIKE '%' || ?1 || '%' AND ws.source != 'naver_cafe' AND ws.filter_passed = 1`
    ).get(region);
    console.log(`\n[${region}] 원문 수집 완료: 성공 ${fetchOk}, 실패 ${fetchFail}, 필터 통과 ${passed?.cnt ?? 0}건`);
  }

  // 3. AI 매칭
  if (checkpoint.phase === "ai") {
    const aiRows = db.query<SourceRow & { full_text: string }, []>(
      `SELECT ws.id, ws.source, ws.title, ws.content, ws.source_url, ws.parking_lot_id, ws.full_text, p.name as lot_name, p.lat as lot_lat, p.lng as lot_lng FROM web_sources ws JOIN parking_lots p ON p.id = ws.parking_lot_id WHERE p.address LIKE '%${region}%' AND ws.source != 'naver_cafe' AND ws.filter_passed = 1 AND ws.id > ${checkpoint.lastId} ORDER BY ws.id`
    ).all();
    console.log(`[${region}] AI 매칭: ${aiRows.length}건 (${AI_CONCURRENCY}건 병렬)`);

    let aiProcessed = 0, aiMatched = 0, aiErrors = 0;
    for (let i = 0; i < aiRows.length; i += AI_CONCURRENCY) {
      const batch = aiRows.slice(i, i + AI_CONCURRENCY);

      await Promise.all(
        batch.map(async (r) => {
          const text = (r as any).full_text || r.content;
          const nearby = allLots
            .map((l) => ({ ...l, dist: haversineKm(r.lot_lat, r.lot_lng, l.lat, l.lng) }))
            .filter((l) => l.dist <= NEARBY_RADIUS_KM)
            .sort((a, b) => a.dist - b.dist);

          try {
            const matches = await aiMatch(text, nearby);
            if (matches.length > 0) {
              for (const m of matches) {
                insertMatchStmt.run(r.id, m.lotId, m.confidence, m.reason || "");
              }
              aiMatched++;
            }
          } catch {
            aiErrors++;
          }
        })
      );

      aiProcessed += batch.length;
      process.stdout.write(`\r[${region}] AI ${aiProcessed}/${aiRows.length} (매칭: ${aiMatched})`);

      checkpoint.lastId = batch[batch.length - 1].id;
      if (aiProcessed % 100 === 0) {
        writeFileSync(CHECKPOINT_FILE, JSON.stringify(checkpoint));
      }

      await new Promise((r) => setTimeout(r, AI_DELAY));
    }

    checkpoint = { phase: "done", lastId: 0 };
    writeFileSync(CHECKPOINT_FILE, JSON.stringify(checkpoint));
    console.log(`\n[${region}] AI 완료: ${aiMatched}건 매칭, ${aiErrors}건 에러`);
  }

  // 4. 결과
  const totalMatches = db.query<{ cnt: number }, []>(
    `SELECT count(*) as cnt FROM web_source_ai_matches wm JOIN web_sources ws ON ws.id = wm.web_source_id JOIN parking_lots p ON p.id = ws.parking_lot_id WHERE p.address LIKE '%${region}%'`
  ).get();
  const uniqueLots = db.query<{ cnt: number }, []>(
    `SELECT count(DISTINCT wm.parking_lot_id) as cnt FROM web_source_ai_matches wm JOIN web_sources ws ON ws.id = wm.web_source_id JOIN parking_lots p ON p.id = ws.parking_lot_id WHERE p.address LIKE '%${region}%'`
  ).get();
  console.log(`[${region}] 결과: ${totalMatches?.cnt ?? 0} 매칭, ${uniqueLots?.cnt ?? 0}개 주차장`);
}

// ─── 메인 ───────────────────────────────────────────────
async function main() {
  console.log(`POI 파이프라인 v3 — 로컬 DB (${DB_PATH})\n`);

  const REGIONS = REGION === "all"
    ? ["수원", "세종", "안산", "천안", "제주", "안양", "고양", "전주", "화성", "평택", "용인", "성남", "광주", "울산", "대전", "부산", "인천", "대구", "서울"]
    : [REGION];

  for (const region of REGIONS) {
    await processRegion(region);
  }

  // 최종 통계
  const total = db.query<{ cnt: number }, []>("SELECT count(*) as cnt FROM web_source_ai_matches").get();
  const lots = db.query<{ cnt: number }, []>("SELECT count(DISTINCT parking_lot_id) as cnt FROM web_source_ai_matches").get();
  console.log(`\n═══ 전체 결과 ═══`);
  console.log(`  총 매칭: ${total?.cnt ?? 0}건`);
  console.log(`  고유 주차장: ${lots?.cnt ?? 0}개`);
}

main().catch((err) => {
  console.error("\n에러:", err.message);
  process.exit(1);
});
