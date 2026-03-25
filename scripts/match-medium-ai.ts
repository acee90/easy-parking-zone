/**
 * medium 매칭 AI 추출 스크립트
 *
 * 1. raw에서 글 10건씩 배치 → AI가 주차장명 추출
 * 2. 추출된 이름으로 FTS 검색 → 후보
 * 3. scoreBlogRelevance로 정밀 채점 → threshold 이상만 저장
 *
 * Usage:
 *   bun run scripts/match-medium-ai.ts --limit 100
 *   bun run scripts/match-medium-ai.ts --remote --limit 500
 *   bun run scripts/match-medium-ai.ts --dry-run --limit 20
 */
import { resolve } from "path";
import { d1Query, isRemote } from "./lib/d1";
import { flushStatements, esc } from "./lib/sql-flush";
import { scoreBlogRelevance, stripHtml } from "../src/server/crawlers/lib/scoring";

const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");
const limitIdx = args.indexOf("--limit");
const LIMIT = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : 100;

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) { console.error("ANTHROPIC_API_KEY 필요"); process.exit(1); }

const AI_BATCH_SIZE = 10;
const DB_FLUSH_SIZE = 100;
const FTS_LIMIT = 10;
const RELEVANCE_THRESHOLD = 60;
const TMP_SQL = resolve(import.meta.dir, "../.tmp-match-medium.sql");

interface RawRow {
  id: number; source: string; source_id: string; source_url: string;
  title: string; content: string; author: string | null;
  published_at: string | null; sentiment_score: number | null;
  ai_difficulty_keywords: string | null; ai_summary: string | null;
}
interface LotRow { lot_id: string; name: string; address: string; }

// ── AI: 글에서 주차장명 추출 ──

const EXTRACT_SYSTEM = `글에서 언급된 주차장 이름을 추출하는 JSON 추출기입니다.

여러 글이 주어집니다. 각 글에서 주차장 이름을 추출하세요.
JSON 배열로 출력: [{"id": 번호, "names": ["주차장이름1", "주차장이름2"]}]

규칙:
- 글에 직접 언급된 주차장 이름만 추출
- "XX 주차장", "XX공영주차장", "XX 제1주차장" 등 구체적 이름
- 주차장 이름이 없으면 빈 배열
- "주차장"이라는 일반 단어만 있고 구체적 이름이 없으면 빈 배열
- 최대 5개까지`;

interface ExtractResult {
  id: number;
  names: string[];
}

async function extractParkingNames(
  items: Array<{ id: number; title: string; content: string }>,
): Promise<ExtractResult[]> {
  const text = items.map((it, i) =>
    `[${i + 1}] 제목: ${it.title.slice(0, 80)} | 내용: ${it.content.slice(0, 200)}`
  ).join("\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200 * items.length,
      system: EXTRACT_SYSTEM,
      messages: [{ role: "user", content: text }],
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) throw new Error(`Haiku ${res.status}`);

  const data = (await res.json()) as { content: Array<{ text: string }> };
  const match = data.content[0].text.match(/\[[\s\S]*\]/);
  if (!match) return items.map((_, i) => ({ id: i + 1, names: [] }));
  return JSON.parse(match[0]) as ExtractResult[];
}

// ── 이름 유사도 ──

const NAME_STRIP = /주차장|공영|민영|노외|노상|부설|유료|무료|임시|기계식/g;

function nameSimilarity(aiName: string, dbName: string): number {
  const a = aiName.toLowerCase().replace(NAME_STRIP, "").replace(/\s+/g, "").trim();
  const b = dbName.toLowerCase().replace(NAME_STRIP, "").replace(/\s+/g, "").trim();
  if (a.length === 0 || b.length === 0) return 0;

  const short = a.length <= b.length ? a : b;
  const long = a.length > b.length ? a : b;

  // 포함 관계
  if (long.includes(short)) return short.length / long.length;

  // 공통 prefix
  let common = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] === b[i]) common++;
    else break;
  }
  return common / Math.max(a.length, b.length);
}

/** AI 추출명과 유사도 0.7 이상인 후보만 반환 */
const SIMILARITY_THRESHOLD = 0.7;

// ── FTS 검색 + 유사도 필터 ──

function searchByName(aiName: string): Array<LotRow & { similarity: number }> {
  const candidates: LotRow[] = [];
  const seen = new Set<string>();

  const words = aiName.replace(NAME_STRIP, "")
    .split(/\s+/).filter(w => w.length >= 2);

  if (words.length === 0) return [];

  // FTS
  const ftsQuery = words.map(w => `"${w}"`).join(" AND ");
  try {
    for (const r of d1Query<LotRow>(`SELECT lot_id, name, address FROM parking_lots_fts WHERE parking_lots_fts MATCH '${esc(ftsQuery)}' LIMIT ${FTS_LIMIT}`)) {
      if (!seen.has(r.lot_id)) { seen.add(r.lot_id); candidates.push(r); }
    }
  } catch {}

  // LIKE 폴백
  if (candidates.length === 0 && words.length > 0) {
    const kw = words[0];
    for (const r of d1Query<LotRow>(`SELECT id as lot_id, name, address FROM parking_lots WHERE name LIKE '%${esc(kw)}%' LIMIT ${FTS_LIMIT}`)) {
      if (!seen.has(r.lot_id)) { seen.add(r.lot_id); candidates.push(r); }
    }
  }

  // 유사도 필터
  return candidates
    .map(c => ({ ...c, similarity: nameSimilarity(aiName, c.name) }))
    .filter(c => c.similarity >= SIMILARITY_THRESHOLD)
    .sort((a, b) => b.similarity - a.similarity);
}

// ── SQL ──

function buildInsertSql(raw: RawRow, lot: LotRow, score: number): string {
  const sid = `${esc(raw.source_id)}:${esc(lot.lot_id)}`;
  const t = esc(stripHtml(raw.title));
  const c = esc(stripHtml(raw.content));
  const a = raw.author ? `'${esc(raw.author)}'` : "NULL";
  const p = raw.published_at ? `'${esc(raw.published_at)}'` : "NULL";
  const ss = raw.sentiment_score ?? "NULL";
  const kj = raw.ai_difficulty_keywords ? `'${esc(raw.ai_difficulty_keywords)}'` : "NULL";
  const sm = raw.ai_summary ? `'${esc(raw.ai_summary)}'` : "NULL";
  return `INSERT OR IGNORE INTO web_sources (parking_lot_id, source, source_id, title, content, source_url, author, published_at, relevance_score, raw_source_id, filter_passed, sentiment_score, ai_difficulty_keywords, ai_summary) VALUES ('${esc(lot.lot_id)}', '${esc(raw.source)}', '${sid}', '${t}', '${c}', '${esc(raw.source_url)}', ${a}, ${p}, ${score}, ${raw.id}, 1, ${ss}, ${kj}, ${sm});`;
}

// ── Main ──

async function main() {
  console.log(`\n🤖 medium 매칭 AI 추출 (${isRemote ? "remote" : "local"} DB, limit=${LIMIT}${isDryRun ? ", dry-run" : ""})\n`);

  const sources = d1Query<RawRow>(
    `SELECT id, source, source_id, source_url, title, content, author, published_at,
            sentiment_score, ai_difficulty_keywords, ai_summary
     FROM web_sources_raw
     WHERE filter_passed = 1 AND matched_at IS NULL
     ORDER BY id LIMIT ${LIMIT}`,
  );
  console.log(`  대기: ${sources.length}건\n`);
  if (sources.length === 0) { console.log("  처리할 항목 없음.\n"); return; }

  let totalLinks = 0;
  let totalExtracted = 0;
  let totalNoName = 0;
  const pendingSql: string[] = [];

  for (let i = 0; i < sources.length; i += AI_BATCH_SIZE) {
    const chunk = sources.slice(i, i + AI_BATCH_SIZE);

    process.stdout.write(`  [${i + 1}~${i + chunk.length}/${sources.length}] `);

    // 1. AI 주차장명 추출
    const items = chunk.map((r, j) => ({
      id: j + 1,
      title: stripHtml(r.title),
      content: stripHtml(r.content),
    }));

    let extractResults: ExtractResult[];
    try {
      extractResults = await extractParkingNames(items);
    } catch (err) {
      console.log(`❌ AI error: ${(err as Error).message}`);
      continue;
    }

    const eMap = new Map(extractResults.map(e => [e.id, e]));
    let batchLinks = 0;

    // 2. 각 raw에 대해 FTS 검색 + scoring
    for (let j = 0; j < chunk.length; j++) {
      const raw = chunk[j];
      const extracted = eMap.get(j + 1);
      const names = extracted?.names ?? [];

      if (names.length === 0) {
        totalNoName++;
        // matched_at 설정 (재처리 방지)
        if (!isDryRun) pendingSql.push(`UPDATE web_sources_raw SET matched_at = datetime('now') WHERE id = ${raw.id};`);
        continue;
      }

      totalExtracted += names.length;
      const title = stripHtml(raw.title);
      const content = stripHtml(raw.content);
      let linked = false;

      for (const name of names) {
        const candidates = searchByName(name);
        for (const lot of candidates) {
          const score = scoreBlogRelevance(title, content, lot.name, lot.address);
          if (score >= RELEVANCE_THRESHOLD) {
            if (isDryRun) {
              console.log(`\n    ✅ "${name}" → ${lot.name} (${score}점, 유사도 ${lot.similarity.toFixed(2)})`);
            } else {
              pendingSql.push(buildInsertSql(raw, lot, score));
            }
            batchLinks++;
            totalLinks++;
            linked = true;
          }
        }
      }

      // matched_at 설정
      if (!isDryRun) {
        pendingSql.push(`UPDATE web_sources_raw SET matched_at = datetime('now') WHERE id = ${raw.id};`);
      }
    }

    if (!isDryRun) {
      console.log(`${batchLinks}건 매칭`);
    }

    // flush
    if (!isDryRun && pendingSql.length >= DB_FLUSH_SIZE) {
      flushStatements(TMP_SQL, pendingSql);
      pendingSql.length = 0;
    }
  }

  // 남은 flush
  if (!isDryRun && pendingSql.length > 0) {
    flushStatements(TMP_SQL, pendingSql);
  }

  console.log(`\n📊 결과`);
  console.log(`  처리: ${sources.length}건`);
  console.log(`  AI 추출 주차장명: ${totalExtracted}건`);
  console.log(`  주차장명 없음: ${totalNoName}건`);
  console.log(`  매칭 저장: ${totalLinks}건`);
  if (isDryRun) console.log(`  ⚠️  dry-run — DB 저장하지 않았습니다.`);
  console.log();
}

main().catch((err) => { console.error("\n에러:", err.message); process.exit(1); });
