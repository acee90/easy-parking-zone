/**
 * 지역 파일럿: 원문 수집 → 필터링 → AI 매칭 → 검증
 *
 * 전체 파이프라인(Phase 2~3)을 소규모로 돌려서 알고리즘 검증.
 * 결과를 JSON으로 저장하여 반복 분석 가능.
 *
 * Usage:
 *   bun run scripts/pilot-region-hanam.ts --remote           # 기본: 하남
 *   bun run scripts/pilot-region-hanam.ts --remote --region 성남
 */
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { d1Query, isRemote } from "./lib/d1";
import { sleep } from "./lib/geo";

const client = new Anthropic();

const REGION = process.argv.find((_, i, arr) => arr[i - 1] === "--region") ?? "하남";
const DIR = resolve(import.meta.dir);
const DATA_FILE = resolve(DIR, `pilot-region-${REGION}-data.json`);
const CHECKPOINT_FILE = resolve(DIR, `pilot-region-${REGION}-checkpoint.json`);

const FETCH_DELAY = 400;
const AI_DELAY = 100;
const AI_CONCURRENCY = 5;

// ─── 타입 ──────────────────────────────────────────────
interface SourceRow {
  id: number;
  source: string;
  title: string;
  content: string;
  source_url: string;
  parking_lot_id: string;
  lot_name: string;
  lot_address: string;
  lot_lat: number;
  lot_lng: number;
  is_ad: number;
}

interface ParkingLot {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
}

interface CollectedItem {
  id: number;
  source: string;
  sourceUrl: string;
  title: string;
  snippet: string;
  parkingLotId: string;
  lotName: string;
  lotAddress: string;
  lotLat: number;
  lotLng: number;
  isAd: boolean;
  fullText: string | null;
  fullTextLength: number;
  fetchError: string | null;
  nearbyLotCount: number;
  // 필터 결과
  filterPassed: boolean;
  filterRemovedBy: string | null;
  // AI 매칭
  aiMatches: Array<{
    lotId: string;
    lotName: string;
    confidence: "high" | "medium" | "low";
    reason: string;
  }>;
  aiError: string | null;
}

interface Checkpoint {
  phase: "fetch" | "ai" | "done";
  lastProcessedIdx: number;
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

async function fetchFullText(source: string, url: string, dbContent: string): Promise<string> {
  if (source === "youtube_comment" || source === "naver_place") {
    return dbContent;
  }
  return fetchBlogFullText(url);
}

// ─── 필터링 (v3: 확실한 것만 제거, 나머지는 AI에게) ─────
const PARKING_KEYWORDS = [
  "주차", "parking", "주차장", "주차비", "주차요금", "주차면", "주차칸",
  "발렛", "기계식", "자주식", "무료주차", "유료주차", "주차타워",
];

function applyFilter(item: CollectedItem): { passed: boolean; removedBy: string | null } {
  const text = item.fullText ?? "";
  const lower = text.toLowerCase();

  if (item.fullTextLength < 100) {
    return { passed: false, removedBy: "tooShort" };
  }
  if (!PARKING_KEYWORDS.some((kw) => lower.includes(kw))) {
    return { passed: false, removedBy: "noParkingKeyword" };
  }
  if (item.nearbyLotCount < 1) {
    return { passed: false, removedBy: "noNearbyLots" };
  }
  return { passed: true, removedBy: null };
}

// ─── AI 매칭 ──────────────────────────────────────────
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
    {
      "lotId": "주차장 ID",
      "lotName": "주차장 이름",
      "confidence": "high" | "medium" | "low",
      "reason": "선택 이유 (1줄)"
    }
  ]
}

매칭되는 주차장이 없으면 빈 배열: {"matches": []}`;

async function aiMatch(
  text: string,
  nearbyLots: ParkingLot[],
): Promise<CollectedItem["aiMatches"]> {
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
    const parsed = JSON.parse(jsonMatch[0]);
    return parsed.matches ?? [];
  } catch {
    // JSON 파싱 실패 시 1회 retry
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
    const parsed = JSON.parse(retryJson[0]);
    return parsed.matches ?? [];
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

// ─── 메인 ───────────────────────────────────────────────
async function main() {
  console.log(`[${REGION}] 지역 파일럿 — ${isRemote ? "REMOTE" : "LOCAL"} DB\n`);

  // 1. 하남시 web_sources 전체 로드
  const rows = d1Query<SourceRow>(
    `SELECT ws.id, ws.source, ws.title, ws.content, ws.source_url, ws.parking_lot_id, ws.is_ad, p.name as lot_name, p.address as lot_address, p.lat as lot_lat, p.lng as lot_lng FROM web_sources ws JOIN parking_lots p ON p.id = ws.parking_lot_id WHERE p.address LIKE '%${REGION}%' AND ws.source != 'naver_cafe'`
  );
  console.log(`[${REGION}] web_sources: ${rows.length}건`);

  const sourceCounts: Record<string, number> = {};
  for (const r of rows) sourceCounts[r.source] = (sourceCounts[r.source] ?? 0) + 1;
  console.log(`[${REGION}] 소스 분포:`, sourceCounts, "\n");

  // 2. 주차장 로드 (하남 근처 — 전국 필요, 5km 반경 계산용)
  console.log(`[${REGION}] DB 주차장 로드...`);
  const allLots = d1Query<ParkingLot>("SELECT id, name, address, lat, lng FROM parking_lots");
  console.log(`[${REGION}] ${allLots.length}개 주차장\n`);

  // 3. 체크포인트 로드
  let items: CollectedItem[] = [];
  let checkpoint: Checkpoint = { phase: "fetch", lastProcessedIdx: -1 };

  if (existsSync(DATA_FILE)) {
    items = JSON.parse(readFileSync(DATA_FILE, "utf-8"));
  }
  if (existsSync(CHECKPOINT_FILE)) {
    checkpoint = JSON.parse(readFileSync(CHECKPOINT_FILE, "utf-8"));
  }

  // 4. Phase: 원문 수집
  if (checkpoint.phase === "fetch") {
    const startIdx = checkpoint.lastProcessedIdx + 1;
    console.log(`[${REGION}] 원문 수집 시작 (idx ${startIdx}부터)\n`);

    for (let i = startIdx; i < rows.length; i++) {
      const r = rows[i];
      process.stdout.write(`\r[${REGION}] fetch ${i + 1}/${rows.length} (${r.source})`);

      let fullText: string | null = null;
      let fetchError: string | null = null;

      try {
        fullText = await fetchFullText(r.source, r.source_url, r.content);
      } catch (err) {
        fetchError = (err as Error).message;
      }

      const nearby = allLots.filter(
        (l) => haversineKm(r.lot_lat, r.lot_lng, l.lat, l.lng) <= 5
      );

      const item: CollectedItem = {
        id: r.id,
        source: r.source,
        sourceUrl: r.source_url,
        title: r.title,
        snippet: r.content,
        parkingLotId: r.parking_lot_id,
        lotName: r.lot_name,
        lotAddress: r.lot_address,
        lotLat: r.lot_lat,
        lotLng: r.lot_lng,
        isAd: r.is_ad === 1,
        fullText: fullText ? fullText.slice(0, 5000) : null,
        fullTextLength: fullText?.length ?? 0,
        fetchError,
        nearbyLotCount: nearby.length,
        filterPassed: false,
        filterRemovedBy: null,
        aiMatches: [],
        aiError: null,
      };

      // 필터 즉시 적용
      const filter = applyFilter(item);
      item.filterPassed = filter.passed;
      item.filterRemovedBy = filter.removedBy;

      if (i < items.length) {
        items[i] = item;
      } else {
        items.push(item);
      }

      if (i % 50 === 0) {
        checkpoint.lastProcessedIdx = i;
        writeFileSync(DATA_FILE, JSON.stringify(items, null, 2));
        writeFileSync(CHECKPOINT_FILE, JSON.stringify(checkpoint));
      }

      if (r.source !== "youtube_comment" && r.source !== "naver_place") {
        await sleep(FETCH_DELAY);
      }
    }

    checkpoint = { phase: "ai", lastProcessedIdx: -1 };
    writeFileSync(DATA_FILE, JSON.stringify(items, null, 2));
    writeFileSync(CHECKPOINT_FILE, JSON.stringify(checkpoint));

    const fetchOk = items.filter((it) => it.fullText).length;
    const fetchFail = items.filter((it) => it.fetchError).length;
    console.log(`\n\n[${REGION}] 원문 수집 완료: 성공 ${fetchOk}, 실패 ${fetchFail}\n`);

    // 필터 퍼널
    const filterPassed = items.filter((it) => it.filterPassed);
    const removedCounts: Record<string, number> = {};
    for (const it of items) {
      if (it.filterRemovedBy) removedCounts[it.filterRemovedBy] = (removedCounts[it.filterRemovedBy] ?? 0) + 1;
    }
    console.log(`[${REGION}] 필터 퍼널:`);
    console.log(`  전체: ${items.length}건`);
    for (const [reason, cnt] of Object.entries(removedCounts).sort((a, b) => b[1] - a[1])) {
      console.log(`  - ${reason}: -${cnt}건`);
    }
    console.log(`  생존: ${filterPassed.length}건 (${((filterPassed.length / items.length) * 100).toFixed(1)}%)\n`);
  }

  // 5. Phase: AI 매칭 (필터 통과분만)
  if (checkpoint.phase === "ai") {
    const aiTargets = items
      .map((it, idx) => ({ it, idx }))
      .filter(({ it }) => it.filterPassed && it.fullText);

    const remaining = aiTargets.filter(({ idx }) => idx > checkpoint.lastProcessedIdx);
    console.log(`[${REGION}] AI 매칭: ${remaining.length}/${aiTargets.length}건 (${AI_CONCURRENCY}건 병렬)\n`);

    let aiProcessed = aiTargets.length - remaining.length;
    for (let i = 0; i < remaining.length; i += AI_CONCURRENCY) {
      const batch = remaining.slice(i, i + AI_CONCURRENCY);

      await Promise.all(
        batch.map(async ({ it }) => {
          const nearby = allLots
            .map((l) => ({ ...l, dist: haversineKm(it.lotLat, it.lotLng, l.lat, l.lng) }))
            .filter((l) => l.dist <= 5)
            .sort((a, b) => a.dist - b.dist);

          try {
            it.aiMatches = await aiMatch(it.fullText!, nearby);
          } catch (err) {
            it.aiError = (err as Error).message;
          }
        })
      );

      aiProcessed += batch.length;
      const lastIdx = batch[batch.length - 1].idx;
      process.stdout.write(`\r[${REGION}] AI ${aiProcessed}/${aiTargets.length}`);

      checkpoint.lastProcessedIdx = lastIdx;
      writeFileSync(DATA_FILE, JSON.stringify(items, null, 2));
      writeFileSync(CHECKPOINT_FILE, JSON.stringify(checkpoint));

      await sleep(AI_DELAY);
    }

    checkpoint = { phase: "done", lastProcessedIdx: items.length - 1 };
    writeFileSync(DATA_FILE, JSON.stringify(items, null, 2));
    writeFileSync(CHECKPOINT_FILE, JSON.stringify(checkpoint));
    console.log(`\n\n[${REGION}] AI 매칭 완료\n`);
  }

  // 6. 결과 리포트
  console.log(`═══ ${REGION}시 파이프라인 결과 ═══\n`);

  const total = items.length;
  const fetchOk = items.filter((it) => it.fullText).length;
  const fetchFail = items.filter((it) => it.fetchError).length;
  const filterPassed = items.filter((it) => it.filterPassed);
  const aiMatched = items.filter((it) => it.aiMatches.length > 0);
  const aiHighConf = items.filter((it) => it.aiMatches.some((m) => m.confidence === "high"));

  console.log("  [파이프라인 퍼널]");
  console.log(`  전체 web_sources    : ${total}건`);
  console.log(`  원문 수집 성공      : ${fetchOk}건 (실패 ${fetchFail}건)`);
  console.log(`  필터 통과           : ${filterPassed.length}건 (${((filterPassed.length / total) * 100).toFixed(1)}%)`);
  console.log(`  AI 매칭 성공        : ${aiMatched.length}건`);
  console.log(`  AI high confidence  : ${aiHighConf.length}건\n`);

  // 소스별 통계
  console.log("  [소스별]");
  const sources = [...new Set(items.map((it) => it.source))];
  for (const src of sources) {
    const srcItems = items.filter((it) => it.source === src);
    const srcPass = srcItems.filter((it) => it.filterPassed).length;
    const srcAi = srcItems.filter((it) => it.aiMatches.length > 0).length;
    console.log(`  ${src.padEnd(16)} ${srcItems.length}건 → 필터 ${srcPass} → AI매칭 ${srcAi}`);
  }
  console.log();

  // AI 매칭 결과 상세
  console.log("  [AI 매칭 상세 (상위 20건)]");
  const matched = items
    .filter((it) => it.aiMatches.length > 0)
    .sort((a, b) => b.aiMatches.length - a.aiMatches.length);

  for (const it of matched.slice(0, 20)) {
    const lots = it.aiMatches.map((m) => `${m.lotName}(${m.confidence})`).join(", ");
    console.log(`  #${it.id} [${it.source}] ${it.title.slice(0, 50)}`);
    console.log(`    기존: ${it.lotName} → AI: ${lots}`);
  }
  console.log();

  // 매칭된 고유 주차장 수
  const uniqueLots = new Set(items.flatMap((it) => it.aiMatches.map((m) => m.lotId)));
  console.log(`  고유 주차장 매칭: ${uniqueLots.size}개`);

  // 1→N 관계 통계
  const multiMatch = items.filter((it) => it.aiMatches.length > 1);
  console.log(`  1→N 매칭 (2개 이상): ${multiMatch.length}건\n`);

  console.log(`  결과 파일: ${DATA_FILE}`);
}

main().catch((err) => {
  console.error("\n에러:", err.message);
  process.exit(1);
});
