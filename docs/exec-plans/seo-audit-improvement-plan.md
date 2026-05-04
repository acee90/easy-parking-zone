# SEO Audit Improvement Plan

> Based on `bun run seo-audit --limit=100 --concurrency=8 --json=data/seo-audit-latest.json` run on 2026-05-04.

## Current Snapshot

Audit sample:

- sitemap URLs: 8,957
- audited pages: 100
- average index potential: 68/100
- bands: 3 strong, 97 moderate, 0 weak, 0 poor
- errors: 12
- warnings: 193

Top issue buckets:

- `INTERNAL_LINKS_LOW`: 95/100 sampled pages
- `BODY_TEXT_THIN`: 60/100 sampled pages
- `PARKING_THIN_CANDIDATE`: capped at 25 examples, plus more
- `SITEMAP_URL_WITHOUT_WEB_SOURCES`: 12 examples
- `DUPLICATE_LOT_NAME_ADDRESS`: 10 examples
- `H1_MISSING`: `/` and `/wiki`

DB-wide local snapshot:

- total lots: 31,939
- lots with `web_sources`: 8,943
- lots with `web_sources` but weak structured/evidence signals: 958
- lots with `web_sources` but no high-relevance source: 4,421
- lots with `web_sources` and any review: 18
- lots with `web_sources` and structured value/review/notes/curation: 7,320

The target URL `스타필드시티 위례 주차장` scores 97/100 with no audit issues, so its GSC state is not a technical eligibility problem. The broader sitemap set is the problem.

## Interpretation

The current sitemap policy is too broad for pages with weak crawl value. `web_sources > 0` is enough to include a lot, but many included lots still render as thin pages: short text, few internal links, and weak structured/evidence signals.

Google is likely seeing a large set of technically valid but low-differentiation pages. That can keep many URLs in `Crawled - currently not indexed` even when individual high-quality pages are eligible.

## Goals

1. Raise average index potential from 68 to 80+ for sitemap-sampled URLs.
2. Reduce `BODY_TEXT_THIN` below 20% in sampled sitemap pages.
3. Reduce `INTERNAL_LINKS_LOW` below 30% in sampled sitemap pages.
4. Remove `SITEMAP_URL_WITHOUT_WEB_SOURCES` mismatches.
5. Keep high-signal pages like 스타필드시티 위례 in sitemap and internally discoverable.

## Phase 1: Fix Sitemap Policy Mismatch

Problem:

- Audit reports sitemap URLs that local DB says have no `web_sources`.
- This may be deploy DB vs local DB drift, stale sitemap cache, or an inclusion query that differs from local expectations.

Actions:

- Compare production D1 and local D1 counts for sitemap-included sample IDs.
- Add a sitemap policy SQL check script or extend `seo-audit` to report local/remote mode explicitly in JSON.
- For sitemap inclusion, require at least one of:
  - `web_sources.relevance_score >= 70`
  - `COUNT(web_sources) >= 3`
  - `user_reviews >= 1`
  - `curation_reason IS NOT NULL`
  - useful structured data such as hours, fees, total spaces, or notes

Expected impact:

- Fewer low-value URLs submitted.
- GSC sitemap quality improves because sitemap becomes a stronger signal of pages we truly want indexed.

## Phase 2: Add Internal Link Modules

Problem:

- 95/100 sampled pages have low internal link count.
- Current detail pages mostly link out to source/blog/media cards but do not link sideways to related internal wiki pages.

Actions:

- Add a "nearby parking lots" internal link section to wiki detail pages.
- Add "same area popular lots" or "same city lots" links when nearby data is sparse.
- Add breadcrumbs: `/wiki` → region/city if region routes exist later; for now `/wiki` → detail.
- Add links from homepage or `/wiki` to more than 30 high-value index candidates.

Suggested query:

- nearest 6 lots by lat/lng within the same broad address prefix.
- prioritize lots with high `indexPotential` signals: web source count, reviews, curation, total spaces.

Expected impact:

- Detail pages become better connected.
- Google gets clearer discovery and relative importance signals beyond sitemap.

## Phase 3: Thicken Parking Detail Content

Problem:

- 60/100 sampled pages have short rendered text.
- Many pages have only address, fee/hours, and generic score blocks.

Actions:

- Generate deterministic, non-AI boilerplate from structured fields:
  - location sentence from address and type
  - hours sentence when explicit
  - fee sentence when explicit/free
  - capacity sentence when total spaces exists
  - source/review evidence sentence
- For lots with web sources and `full_text_status='ok'`, generate or refresh 2-3 sentence `aiSummary`.
- Fill `aiTipPricing`, `aiTipVisit`, `aiTipAlternative` for top 1,000 sitemap candidates.
- Prefer official/structured sources for hours/fees before blog-derived text.

Minimum content target:

- 900+ rendered Korean characters for sitemap pages.
- 1,800+ rendered Korean characters for priority pages.

Expected impact:

- More pages cross from moderate to strong index potential.
- Lower thin-content clustering across sitemap.

## Phase 4: Add H1 and Static Page Quality Fixes

Problem:

- `/` and `/wiki` are missing `h1` in audit.
- These are important internal hubs.

Actions:

- Add a visually appropriate `h1` to home and wiki pages.
- Ensure `/wiki` has enough static crawlable links and text.
- Avoid marketing copy; make it an actual browse hub with rankings and internal links.

Expected impact:

- Hub pages become stronger crawl entry points.

## Phase 5: Duplicate Lot Canonical Review

Problem:

- duplicate `name + address` groups may split canonical signals.

Actions:

- Export duplicate groups and classify:
  - true duplicate same lot
  - multiple entrances/sections
  - stale source records
- For true duplicates, choose canonical lot and either merge data or add canonical redirect/alias policy.
- Do not delete or redirect until source-specific differences are understood.

Expected impact:

- Prevents internal competition and inconsistent page quality.

## Execution Order

1. Fix sitemap inclusion threshold and remote/local policy mismatch.
2. Add related internal links to detail pages.
3. Add `h1` to `/` and `/wiki`.
4. Generate structured fallback content for sitemap pages.
5. Re-run `seo-audit --limit=500 --json=data/seo-audit-after-phase1.json`.
6. Promote only strong/moderate-high pages to sitemap until average index potential reaches 80+.

## Acceptance Criteria

- `bun run seo-audit --limit=500 --concurrency=8` shows:
  - average index potential >= 80
  - `SITEMAP_URL_WITHOUT_WEB_SOURCES = 0`
  - `BODY_TEXT_THIN < 20%`
  - `INTERNAL_LINKS_LOW < 30%`
- `bun run build` succeeds.
- 스타필드시티 위례 remains:
  - sitemap included
  - canonical self
  - noindex absent
  - index potential >= 90

## Notes

- `indexPotentialScore` is an operational metric, not a Google metric.
- The immediate GSC fix for a strong page remains: sitemap submitted, URL inspection request, then wait for recrawl/reprocessing.
- The scalable fix is to stop submitting weak pages and strengthen internal links/content for pages we do submit.
