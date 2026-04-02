/**
 * Remote DB에서 미분류 web_sources_raw를 local JSON으로 추출
 * Usage: bun run scripts/oneshot/dump-unfiltered.ts
 */
import { writeFileSync } from "fs";

const BATCH = 5000;
const OUT = "/tmp/unfiltered_all.json";

async function query(sql: string) {
  const proc = Bun.spawn(
    ["npx", "wrangler", "d1", "execute", "parking-db", "--remote", "--json", "--command", sql],
    { stdout: "pipe", stderr: "pipe" },
  );
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  const parsed = JSON.parse(text);
  return parsed[0]?.results ?? [];
}

async function main() {
  let lastId = 0;
  let total = 0;
  const allRows: any[] = [];

  while (true) {
    console.log(`Fetching after id=${lastId} ...`);
    const rows = await query(
      `SELECT id, title, content, source_url FROM web_sources_raw WHERE ai_filtered_at IS NULL AND id > ${lastId} ORDER BY id ASC LIMIT ${BATCH}`,
    );

    if (rows.length === 0) break;

    allRows.push(...rows);
    lastId = rows[rows.length - 1].id;
    total += rows.length;
    console.log(`  got ${rows.length}, total ${total}, last id=${lastId}`);
  }

  writeFileSync(OUT, JSON.stringify(allRows));
  console.log(`\nDone: ${total} rows → ${OUT} (${(Buffer.byteLength(JSON.stringify(allRows)) / 1024 / 1024).toFixed(1)}MB)`);
}

main();
