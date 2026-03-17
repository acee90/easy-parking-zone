/**
 * 필터 v2 수집: 500건 샘플 + 원문 수집 + AI 매칭
 *
 * 결과를 JSON으로 저장하여 eval 스크립트에서 반복 사용.
 * 체크포인트 지원 — 중단 후 재개 가능.
 *
 * Usage:
 *   bun run scripts/pilot-filter-v2-collect.ts --remote
 */
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { d1Query, isRemote } from "./lib/d1";
import { sleep } from "./lib/geo";

const client = new Anthropic();

const DIR = resolve(import.meta.dir);
const SAMPLE_FILE = resolve(DIR, "pilot-filter-v2-sample.json");
const RESULT_FILE = resolve(DIR, "pilot-filter-v2-data.json");
const CHECKPOINT_FILE = resolve(DIR, "pilot-filter-v2-checkpoint.json");

const FETCH_DELAY = 400;
const AI_DELAY = 100;
const AI_CONCURRENCY = 5;
const SAMPLE_SIZE = 500;

// ─── 타입 ──────────────────────────────────────────────
interface SampleRow {
  id: number;
  source: string;
  title: string;
  content: string;
  source_url: string;
  parking_lot_id: string;
  lot_name: string;
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
  lotLat: number;
  lotLng: number;
  isAd: boolean;
  fullText: string | null;
  fullTextLength: number;
  fetchError: string | null;
  nearbyLotCount: number;
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

function toCafeMobileUrl(url: string): string {
  const match = url.match(/cafe\.naver\.com\/([^/]+)\/(\d+)/);
  if (match) {
    return `https://m.cafe.naver.com/ca-fe/web/cafes/${match[1]}/articles/${match[2]}`;
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

async function fetchCafeFullText(url: string): Promise<string> {
  const mobileUrl = toCafeMobileUrl(url);
  const res = await fetch(mobileUrl, {
    headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const bodyMatch = html.match(/<body[\s\S]*<\/body>/i);
  return htmlToText(bodyMatch?.[0] ?? html);
}

async function fetchFullText(source: string, url: string, dbContent: string): Promise<string> {
  // youtube_comment, naver_place: DB content 그대로 사용
  if (source === "youtube_comment" || source === "naver_place") {
    return dbContent;
  }
  if (url.includes("cafe.naver.com")) return fetchCafeFullText(url);
  return fetchBlogFullText(url);
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
  const parsed = JSON.parse(jsonMatch[0]);
  return parsed.matches ?? [];
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
  console.log(`[Collect] 필터 v2 데이터 수집 — ${isRemote ? "REMOTE" : "LOCAL"} DB\n`);

  // 1. 샘플링 (캐시 또는 DB)
  let samples: SampleRow[];
  if (existsSync(SAMPLE_FILE)) {
    samples = JSON.parse(readFileSync(SAMPLE_FILE, "utf-8"));
    console.log(`[Collect] 샘플 캐시 로드: ${samples.length}건`);
  } else {
    console.log("[Collect] DB에서 계층적 샘플링...");

    // 소스별 비율에 맞게 샘플링
    const blogSamples = d1Query<SampleRow>(
      `SELECT ws.id, ws.source, ws.title, ws.content, ws.source_url, ws.parking_lot_id, ws.is_ad, p.name as lot_name, p.lat as lot_lat, p.lng as lot_lng FROM web_sources ws JOIN parking_lots p ON p.id = ws.parking_lot_id WHERE ws.source = 'naver_blog' ORDER BY RANDOM() LIMIT 250`
    );
    const cafeSamples = d1Query<SampleRow>(
      `SELECT ws.id, ws.source, ws.title, ws.content, ws.source_url, ws.parking_lot_id, ws.is_ad, p.name as lot_name, p.lat as lot_lat, p.lng as lot_lng FROM web_sources ws JOIN parking_lots p ON p.id = ws.parking_lot_id WHERE ws.source = 'naver_cafe' ORDER BY RANDOM() LIMIT 150`
    );
    const poiSamples = d1Query<SampleRow>(
      `SELECT ws.id, ws.source, ws.title, ws.content, ws.source_url, ws.parking_lot_id, ws.is_ad, p.name as lot_name, p.lat as lot_lat, p.lng as lot_lng FROM web_sources ws JOIN parking_lots p ON p.id = ws.parking_lot_id WHERE ws.source = 'poi' ORDER BY RANDOM() LIMIT 70`
    );
    const otherSamples = d1Query<SampleRow>(
      `SELECT ws.id, ws.source, ws.title, ws.content, ws.source_url, ws.parking_lot_id, ws.is_ad, p.name as lot_name, p.lat as lot_lat, p.lng as lot_lng FROM web_sources ws JOIN parking_lots p ON p.id = ws.parking_lot_id WHERE ws.source IN ('youtube_comment', 'naver_place') ORDER BY RANDOM() LIMIT 30`
    );

    samples = [...blogSamples, ...cafeSamples, ...poiSamples, ...otherSamples];
    writeFileSync(SAMPLE_FILE, JSON.stringify(samples, null, 2));
    console.log(`[Collect] ${samples.length}건 샘플 저장`);
  }

  // 소스별 통계
  const sourceCounts: Record<string, number> = {};
  for (const s of samples) {
    sourceCounts[s.source] = (sourceCounts[s.source] ?? 0) + 1;
  }
  console.log("[Collect] 소스 분포:", sourceCounts, "\n");

  // 2. DB 주차장 로드
  console.log("[Collect] DB 주차장 로드...");
  const allLots = d1Query<ParkingLot>("SELECT id, name, address, lat, lng FROM parking_lots");
  console.log(`[Collect] ${allLots.length}개 주차장\n`);

  // 3. 체크포인트 로드
  let items: CollectedItem[] = [];
  let checkpoint: Checkpoint = { phase: "fetch", lastProcessedIdx: -1 };

  if (existsSync(RESULT_FILE)) {
    items = JSON.parse(readFileSync(RESULT_FILE, "utf-8"));
  }
  if (existsSync(CHECKPOINT_FILE)) {
    checkpoint = JSON.parse(readFileSync(CHECKPOINT_FILE, "utf-8"));
  }

  // 4. Phase: 원문 수집
  if (checkpoint.phase === "fetch") {
    const startIdx = checkpoint.lastProcessedIdx + 1;
    console.log(`[Collect] 원문 수집 시작 (idx ${startIdx}부터)\n`);

    for (let i = startIdx; i < samples.length; i++) {
      const s = samples[i];
      process.stdout.write(`\r[Collect] fetch ${i + 1}/${samples.length} (${s.source})`);

      let fullText: string | null = null;
      let fetchError: string | null = null;

      try {
        fullText = await fetchFullText(s.source, s.source_url, s.content);
      } catch (err) {
        fetchError = (err as Error).message;
      }

      // 근접 주차장 후보
      const nearby = allLots.filter(
        (l) => haversineKm(s.lot_lat, s.lot_lng, l.lat, l.lng) <= 5
      );

      // items 배열 구성 (AI 매칭은 아직 비어있음)
      if (i < items.length) {
        // 이미 있는 항목 업데이트
        items[i].fullText = fullText ? fullText.slice(0, 3000) : null;
        items[i].fullTextLength = fullText?.length ?? 0;
        items[i].fetchError = fetchError;
        items[i].nearbyLotCount = nearby.length;
      } else {
        items.push({
          id: s.id,
          source: s.source,
          sourceUrl: s.source_url,
          title: s.title,
          snippet: s.content,
          parkingLotId: s.parking_lot_id,
          lotName: s.lot_name,
          lotLat: s.lot_lat,
          lotLng: s.lot_lng,
          isAd: s.is_ad === 1,
          fullText: fullText ? fullText.slice(0, 3000) : null,
          fullTextLength: fullText?.length ?? 0,
          fetchError,
          nearbyLotCount: nearby.length,
          aiMatches: [],
          aiError: null,
        });
      }

      // 체크포인트 (50건마다)
      if (i % 50 === 0) {
        checkpoint.lastProcessedIdx = i;
        writeFileSync(RESULT_FILE, JSON.stringify(items, null, 2));
        writeFileSync(CHECKPOINT_FILE, JSON.stringify(checkpoint));
      }

      if (s.source !== "youtube_comment" && s.source !== "naver_place") {
        await sleep(FETCH_DELAY);
      }
    }

    // fetch 완료
    checkpoint = { phase: "ai", lastProcessedIdx: -1 };
    writeFileSync(RESULT_FILE, JSON.stringify(items, null, 2));
    writeFileSync(CHECKPOINT_FILE, JSON.stringify(checkpoint));

    const fetchOk = items.filter((it) => it.fullText).length;
    const fetchFail = items.filter((it) => it.fetchError).length;
    console.log(`\n\n[Collect] 원문 수집 완료: 성공 ${fetchOk}, 실패 ${fetchFail}\n`);
  }

  // 5. Phase: AI 매칭
  if (checkpoint.phase === "ai") {
    const startIdx = checkpoint.lastProcessedIdx + 1;
    // 원문이 있고 100자 이상인 항목만 AI 매칭
    const aiTargets = items
      .map((it, idx) => ({ it, idx }))
      .filter(({ it }) => it.fullText && it.fullTextLength >= 100);

    // 미처리 대상만 필터
    const remaining = aiTargets.filter(({ idx }) => idx > checkpoint.lastProcessedIdx);
    console.log(`[Collect] AI 매칭 시작: ${remaining.length}/${aiTargets.length}건 (${AI_CONCURRENCY}건 병렬)\n`);

    let aiProcessed = aiTargets.length - remaining.length;
    for (let i = 0; i < remaining.length; i += AI_CONCURRENCY) {
      const batch = remaining.slice(i, i + AI_CONCURRENCY);

      // 병렬 AI 호출
      await Promise.all(
        batch.map(async ({ it, idx }) => {
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
      process.stdout.write(`\r[Collect] AI ${aiProcessed}/${aiTargets.length}`);

      // 체크포인트 (배치마다)
      checkpoint.lastProcessedIdx = lastIdx;
      writeFileSync(RESULT_FILE, JSON.stringify(items, null, 2));
      writeFileSync(CHECKPOINT_FILE, JSON.stringify(checkpoint));

      await sleep(AI_DELAY);
    }

    checkpoint = { phase: "done", lastProcessedIdx: items.length - 1 };
    writeFileSync(RESULT_FILE, JSON.stringify(items, null, 2));
    writeFileSync(CHECKPOINT_FILE, JSON.stringify(checkpoint));
    console.log(`\n\n[Collect] AI 매칭 완료\n`);
  }

  // 6. 요약
  const withText = items.filter((it) => it.fullText);
  const withAi = items.filter((it) => it.aiMatches.length > 0);
  const aiErrors = items.filter((it) => it.aiError);

  console.log("═══ 수집 요약 ═══");
  console.log(`  전체 샘플: ${items.length}건`);
  console.log(`  원문 수집 성공: ${withText.length}건`);
  console.log(`  AI 매칭 있음: ${withAi.length}건`);
  console.log(`  AI 에러: ${aiErrors.length}건`);
  console.log(`  결과 파일: ${RESULT_FILE}`);
}

main().catch((err) => {
  console.error("\n에러:", err.message);
  process.exit(1);
});
