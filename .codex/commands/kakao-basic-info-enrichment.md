# Kakao Basic Info Enrichment

Use this command when the user wants to fill missing `parking_lots` basic info from Kakao without repeatedly querying remote D1.

Do not start the full batch until the user explicitly confirms. This job can take 4-5 hours for the current remote residual set.

## Goal

Enrich missing KA off-street parking basic info using this order:

1. Export remote D1 target rows once.
2. Run Kakao crawling locally against the exported JSON.
3. Generate SQL chunk files locally only.
4. Combine SQL files.
5. Review counts and sample SQL.
6. Apply to remote D1 once, only after confirmation.

## Preconditions

- Workdir: `/Users/junhee/Documents/projects/parking-map/main`
- Use `bunx wrangler`, not `npx wrangler`.
- Do not run per-lot remote D1 queries.
- Do not write `total_spaces` from Kakao.
- Phone-only missing rows are not a priority.
- If a process is interrupted, check for leftover `enrich-kakao-place`, `chrome-headless`, or `chromium` processes before restarting.

## Prepare

```bash
mkdir -p eval/kakao-sql-chunks eval/kakao-logs

bun run scripts/export-kakao-enrichment-targets.ts \
  --remote \
  --out=eval/kakao-enrichment-targets.remote.json
```

## Sample 100 Rows

Run this before a full batch unless a recent sample already exists.

```bash
time bun run scripts/enrich-kakao-place.ts \
  --targets-json=eval/kakao-enrichment-targets.remote.json \
  --offset=0 \
  --limit=100 \
  --sql-out=eval/kakao-sql-chunks/kakao-update-000000.sql
```

Report:

- elapsed time
- target count
- generated UPDATE count
- operating-hours count
- fee count
- daily-max count
- estimated full runtime

Current measured baseline: 100 rows took about 1m57s, so 11,719 rows is about 3h50m raw and 4-5h with margin.

## Full SQL Generation

Only run after explicit user confirmation.

```bash
nohup bash -lc '
set -euo pipefail

for offset in $(seq 100 100 11700); do
  padded=$(printf "%06d" "$offset")
  echo "=== chunk offset=$offset start $(date) ==="
  bun run scripts/enrich-kakao-place.ts \
    --targets-json=eval/kakao-enrichment-targets.remote.json \
    --offset="$offset" \
    --limit=100 \
    --sql-out="eval/kakao-sql-chunks/kakao-update-${padded}.sql"
  echo "=== chunk offset=$offset done $(date) ==="
done

cat eval/kakao-sql-chunks/kakao-update-*.sql > eval/kakao-update-all.sql
wc -l eval/kakao-update-all.sql
' > eval/kakao-logs/kakao-enrich-chunks.log 2>&1 &

echo $!
```

Monitor:

```bash
tail -80 eval/kakao-logs/kakao-enrich-chunks.log
find eval/kakao-sql-chunks -name 'kakao-update-*.sql' | wc -l
ps aux | rg 'enrich-kakao-place|chrome-headless|chromium' | rg -v rg
```

## Review Before Apply

```bash
wc -l eval/kakao-update-all.sql
sed -n '1,20p' eval/kakao-update-all.sql
rg "total_spaces|DELETE|DROP|ALTER|INSERT" eval/kakao-update-all.sql
```

Expected:

- SQL contains only `UPDATE parking_lots SET ... WHERE id = 'KA-...'`.
- No `total_spaces` updates.
- No destructive SQL.

## Apply Once To Remote

Only run after user confirms the SQL review.

```bash
bunx wrangler d1 execute parking-db \
  --remote \
  --file=eval/kakao-update-all.sql
```

## Verify

Use aggregate reports, not per-lot remote loops.

```bash
bun run scripts/report-kakao-residuals.ts --remote
```

Report final:

- remote apply success/failure
- SQL update line count
- residual before/after if available
- any failed chunks
- where logs and SQL files are stored
