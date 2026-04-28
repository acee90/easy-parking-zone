# Kakao Basic Info Enrichment Codex Command

Canonical command file:

`/.codex/commands/kakao-basic-info-enrichment.md`

Purpose:

- Avoid remote D1 per-row query/write loops.
- Export target rows from remote once.
- Generate local SQL chunks from Kakao crawling.
- Apply one combined SQL file to remote only after review.

Current baseline:

- Remote target export: `11,719` KA off-street rows with missing hours or fee.
- Sample runtime: `100` rows in about `1m57s`.
- Estimated full runtime: about `3h50m` raw, `4-5h` with margin.
- First sample SQL already exists at `eval/kakao-sql-chunks/kakao-update-000000.sql`.

Safety rule:

- The full batch and remote apply require explicit confirmation.
- The generated SQL must be reviewed before `bunx wrangler d1 execute ... --file`.
