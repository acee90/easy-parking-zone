# SEO Audit Script Standard

> Goal: keep indexable parking wiki pages aligned with Google crawl/index rules, sitemap protocol requirements, and easy-parking's own thin-content policy.

## Context

Search Console can show `Crawled - currently not indexed` even when a page is technically eligible for indexing. For this project, the recurring failure modes are:

- sitemap discovery and GSC reporting lag
- sitemap URL, canonical URL, and rendered slug drift
- `index` pages with weak page-level content
- high-value parking lots missing from sitemap or internal links
- `noindex` or thin pages accidentally included in sitemap

The audit script should not try to predict Google's final indexing decision. It should verify that every page we ask Google to crawl is technically eligible and consistent with our inclusion policy.

## Standards Used

- Google Search Central technical requirements: public access, crawlable pages, indexability directives.
- Google robots meta and `X-Robots-Tag` rules: page/header directives control whether Google may index a crawled page.
- Google canonical guidance: canonical hints should be consistent across HTML, redirects, internal links, and sitemap inclusion.
- Sitemaps.org protocol: XML sitemap index and urlset format, UTF-8, required `loc`, same-site URL scope.

## Audit Layers

### 0. Index Potential Signals

The script reports an `indexPotentialScore` from 0 to 100. This is not a Google metric. It is an operational score that tracks signals that usually improve the chance that a crawled URL is selected for indexing:

- Discovery: URL is in sitemap and linked from an indexable page such as `/wiki`.
- Technical eligibility: `200`, no `noindex`, canonical self-reference.
- Content quality: title, description, `h1`, substantial rendered body text.
- Entity clarity: valid JSON-LD and parking-specific facts such as address, hours, price, phone.
- Uniqueness and evidence: web source count, high-relevance source count, reviews, media/blog counts.
- Internal importance: internal links on the page and inclusion in ranking/list pages.

Score bands:

- `80-100`: strong index candidate; if GSC says `Crawled - currently not indexed`, wait or request indexing first.
- `60-79`: technically eligible but worth strengthening content/internal links.
- `40-59`: weak candidate; add unique content/evidence before pushing more crawl requests.
- `<40`: likely thin or inconsistent; do not prioritize for indexing.

### 1. Protocol Checks

- `/robots.txt` returns `200`.
- `robots.txt` declares `Sitemap: https://easy-parking.xyz/sitemap.xml`.
- `/sitemap.xml` returns XML and is a sitemap index.
- child sitemaps return XML urlsets.
- sitemap URLs stay on the canonical host.
- sampled sitemap URLs return `200`.

### 2. Indexability Checks

For every audited URL:

- final URL has no unexpected host drift.
- HTTP status is `200`.
- `X-Robots-Tag` does not contain `noindex`.
- `<meta name="robots">` does not contain `noindex`.
- canonical exists.
- canonical resolves to the same normalized URL for indexable wiki detail pages.
- page has one or more useful headings and a non-empty body.

### 3. Content Checks

These are warnings, not hard failures:

- missing or duplicate title.
- title too short.
- missing or duplicate meta description.
- description too short.
- missing `h1`.
- very short rendered body text.
- invalid JSON-LD.
- very low internal link count.
- low `indexPotentialScore`.

### 4. Parking-Specific Checks

For wiki detail pages:

- `parking_lots` rows with one or more `web_sources` should appear in sitemap.
- sitemap should not include lots with no `web_sources`.
- generated slug from `makeParkingSlug(name, id)` should match sitemap URL.
- likely thin candidates are flagged when they have weak structured data and weak human-facing text.
- duplicate `name + address` groups are reported as canonicalization risks.
- `indexPotentialScore` includes DB evidence fields when D1 is available.

## Command

```bash
bun run seo-audit --limit=100
```

Useful variants:

```bash
bun run seo-audit --url=https://easy-parking.xyz/wiki/스타필드시티-위례-주차장-KA-1935812519
bun run seo-audit --limit=500 --concurrency=8
bun run seo-audit --skip-db --limit=100
bun run seo-audit --remote --limit=100
bun run seo-audit --json=data/seo-audit.json --limit=100
```

## Exit Policy

Default mode prints findings and exits successfully so the script can be used during investigation. `--strict` exits non-zero when hard failures are found:

- robots/sitemap fetch failure
- sitemap URL non-`200`
- sitemap URL rendered with `noindex`
- sitemap URL canonical mismatch
- invalid sitemap XML

Warnings are intended for prioritization and should not fail CI until thresholds are calibrated.

## Follow-Up

- Add GSC export ingestion later so audit output can group pages by GSC exclusion reason.
- Add historical JSON snapshots to detect regressions in indexable URL count.
- Add internal link depth crawl from `/wiki` and homepage once route-level linking stabilizes.
