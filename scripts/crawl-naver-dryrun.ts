/**
 * 네이버 통합 크롤러 dry-run 스크립트
 *
 * 3가지 쿼리 전략(이름/POI/지역)으로 검색하고,
 * 다중 매칭까지 시뮬레이션. DB 저장 없이 결과만 출력.
 *
 * Usage: bun run scripts/crawl-naver-dryrun.ts [--remote] [--limit 10]
 */
import { execSync } from "child_process";
import {
  extractRegion,
  isGenericName,
  stripHtml,
  parsePostdate,
  hashUrl,
  scoreBlogRelevance,
} from "../src/server/crawlers/lib/scoring";

// ── CLI 옵션 ──
const args = process.argv.slice(2);
const isRemote = args.includes("--remote");
const limitIdx = args.indexOf("--limit");
const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : 5;

// ── D1 접근 ──
function queryD1<T>(sql: string): T[] {
  const dbFlag = isRemote ? "--remote" : "";
  const cmd = `npx wrangler d1 execute parking-db ${dbFlag} --json --command="${sql.replace(/"/g, '\\"')}"`;
  const out = execSync(cmd, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
  const parsed = JSON.parse(out);
  return parsed[0]?.results ?? [];
}

// ── 네이버 검색 ──
const BLOG_URL = "https://openapi.naver.com/v1/search/blog.json";
const CAFE_URL = "https://openapi.naver.com/v1/search/cafearticle.json";

interface NaverItem {
  title: string;
  link: string;
  description: string;
  bloggername?: string;
  cafename?: string;
  postdate?: string;
}

async function searchNaver(url: string, query: string): Promise<NaverItem[]> {
  const clientId = process.env.NAVER_CLIENT_ID!;
  const clientSecret = process.env.NAVER_CLIENT_SECRET!;
  const params = new URLSearchParams({ query, display: "5", sort: "sim" });
  const res = await fetch(`${url}?${params}`, {
    headers: {
      "X-Naver-Client-Id": clientId,
      "X-Naver-Client-Secret": clientSecret,
    },
  });
  if (!res.ok) throw new Error(`Naver ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { items: NaverItem[] };
  return data.items ?? [];
}

// ── 쿼리 전략 ──
interface LotRow {
  id: string;
  name: string;
  address: string;
  reliability: string | null;
  poi_tags: string | null;
}

type Strategy = "name" | "poi" | "region";

function buildQueries(lot: LotRow): Array<{ strategy: Strategy; query: string }> {
  const region = extractRegion(lot.address);
  const queries: Array<{ strategy: Strategy; query: string }> = [];

  if (!isGenericName(lot.name)) {
    queries.push({ strategy: "name", query: `${lot.name} 주차장 ${region}`.trim() });
  }

  const poiTags: string[] = lot.poi_tags ? JSON.parse(lot.poi_tags) : [];
  if (poiTags.length > 0) {
    queries.push({ strategy: "poi", query: `${poiTags[0]} 주차장` });
  }

  if (queries.length === 0) {
    queries.push({ strategy: "region", query: `${region} 주차장 추천` });
  }

  return queries;
}

// ── 다중 매칭 스캔 ──
function scanMultiMatches(title: string, desc: string, anchorId: string, allLots: LotRow[]): string[] {
  const combined = (stripHtml(title) + " " + stripHtml(desc)).toLowerCase();
  const matched: string[] = [];

  for (const lot of allLots) {
    if (lot.id === anchorId || isGenericName(lot.name)) continue;
    const keywords = lot.name.toLowerCase()
      .replace(/주차장|공영|노외|노상|부설/g, "")
      .split(/\s+/)
      .filter((w) => w.length >= 2);
    if (keywords.length > 0 && keywords.some((kw) => combined.includes(kw))) {
      matched.push(lot.name);
    }
  }
  return matched;
}

// ── 메인 ──
const STRATEGY_LABEL = { name: "🅰️ 이름", poi: "🅱️ POI", region: "🅲 지역" };

async function main() {
  console.log(`\n🔍 통합 크롤러 dry-run (${isRemote ? "remote" : "local"} DB, limit=${limit})\n`);

  const lots = queryD1<LotRow>(
    `SELECT p.id, p.name, p.address, s.reliability, p.poi_tags
     FROM parking_lots p
     LEFT JOIN parking_lot_stats s ON p.id = s.parking_lot_id
     LEFT JOIN crawl_progress cp ON cp.crawler_id = 'naver_blogs_lot:' || p.id
     WHERE cp.last_run_at IS NULL OR julianday('now') - julianday(cp.last_run_at) > 30
     ORDER BY
       CASE s.reliability
         WHEN 'none' THEN 0 WHEN 'structural' THEN 1
         WHEN 'reference' THEN 2 WHEN 'estimated' THEN 3 ELSE 4
       END,
       cp.last_run_at ASC NULLS FIRST, p.id
     LIMIT ${limit}`,
  );

  console.log(`  선택된 주차장: ${lots.length}개\n`);

  let totalSaved = 0;
  let totalMultiMatch = 0;
  const strategyCounts = { name: 0, poi: 0, region: 0 };

  for (const lot of lots) {
    const queries = buildQueries(lot);

    console.log(`─── ${lot.name} (${lot.reliability ?? "없음"}) ───`);
    if (lot.poi_tags) console.log(`  POI: ${lot.poi_tags}`);

    for (const { strategy, query } of queries) {
      strategyCounts[strategy]++;
      console.log(`  전략: ${STRATEGY_LABEL[strategy]} → "${query}"`);

      for (const [label, url] of [["📝 블로그", BLOG_URL], ["☕ 카페", CAFE_URL]] as const) {
        try {
          const results = await searchNaver(url, query);
          console.log(`    ${label}: ${results.length}건`);
          for (const item of results) {
            const score = scoreBlogRelevance(item.title, item.description, lot.name, lot.address);
            const pass = score >= 60;
            const title = stripHtml(item.title).slice(0, 55);
            const multiMatches = pass && strategy !== "name"
              ? scanMultiMatches(item.title, item.description, lot.id, lots)
              : [];

            const matchInfo = multiMatches.length > 0
              ? ` +${multiMatches.length}매칭(${multiMatches.slice(0, 2).join(",")})`
              : "";
            console.log(`      ${pass ? "✅" : "❌"} [${score}점] ${title}${matchInfo}`);

            if (pass) totalSaved++;
            totalMultiMatch += multiMatches.length;
          }
        } catch (err) {
          console.log(`    ${label} 에러: ${(err as Error).message}`);
        }
      }
      await new Promise((r) => setTimeout(r, 300));
    }

    console.log();
  }

  console.log(`📊 결과 요약`);
  console.log(`  처리: ${lots.length}개 주차장`);
  console.log(`  전략: 이름=${strategyCounts.name} POI=${strategyCounts.poi} 지역=${strategyCounts.region}`);
  console.log(`  저장 예정: ${totalSaved}건 (threshold ≥ 60)`);
  console.log(`  다중 매칭: ${totalMultiMatch}건`);
}

main().catch(console.error);
