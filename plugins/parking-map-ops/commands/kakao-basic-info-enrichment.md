---
description: Generate Kakao basic-info enrichment SQL without remote D1 per-row loops
argument-hint: [sample|prepare|generate|review|apply|verify]
allowed-tools: [Read, Glob, Grep, Bash, Write, Edit]
---

# Kakao Basic Info Enrichment

## Arguments

The user invoked this command with: `$ARGUMENTS`

## Instructions

Use this command for Parking Map Kakao basic-info enrichment. Work from:

`/Users/junhee/Documents/projects/parking-map/main`

Do not start the full batch or apply SQL to remote D1 unless the user explicitly confirms that step.

Follow the canonical workflow in:

`.codex/commands/kakao-basic-info-enrichment.md`

Required safety rules:

1. Do not query remote D1 per lot.
2. Export target rows from remote D1 once.
3. Crawl Kakao against the exported local JSON.
4. Generate SQL chunks locally.
5. Review combined SQL before applying.
6. Apply to remote D1 once with `bunx wrangler d1 execute ... --file`.
7. Do not write `total_spaces` from Kakao.
8. Ignore phone-only missing rows for this batch.

Useful commands:

```bash
bun run scripts/export-kakao-enrichment-targets.ts \
  --remote \
  --out=eval/kakao-enrichment-targets.remote.json
```

```bash
time bun run scripts/enrich-kakao-place.ts \
  --targets-json=eval/kakao-enrichment-targets.remote.json \
  --offset=0 \
  --limit=100 \
  --sql-out=eval/kakao-sql-chunks/kakao-update-000000.sql
```

```bash
bunx wrangler d1 execute parking-db \
  --remote \
  --file=eval/kakao-update-all.sql
```

Expected baseline:

- Current exported remote target count: `11,719`.
- Sample runtime: about `1m57s` per `100` rows.
- Full generation estimate: `4-5h`.
