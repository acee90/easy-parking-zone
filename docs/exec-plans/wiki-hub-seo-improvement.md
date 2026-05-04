# Wiki Hub SEO Improvement

> Goal: make `/wiki` a useful SSR browse hub, not just a thin list of links.

## Problem

The current `/wiki` page links to ranking sections, but it has weak standalone content:

- no strong `h1`
- little explanatory text around selection criteria
- limited internal links relative to the size of the site
- no region/category browse layer
- weak crawl context for why linked pages are important

This makes `/wiki` less useful as an internal linking hub for Googlebot and less useful for users who want to compare parking lots by purpose.

## Direction

Build `/wiki` as a dense operational browse page:

- clear `h1`
- short, factual intro
- criteria explanations for each ranking block
- more SSR-rendered internal links
- regional representative sections
- practical parking checklist content

Avoid a marketing landing page. The first screen should remain a browse experience.

## Target Structure

1. Header area
   - `h1`: 전국 주차장 둘러보기
   - short paragraph explaining data sources and ranking criteria
   - compact stats chips

2. Browse groups
   - 초보 추천 주차장
   - 넓은 주차장
   - 무료 주차장
   - 웹에서 많이 언급된 주차장
   - 최근 정보가 보강된 주차장

3. Region sections
   - 서울
   - 경기
   - 부산
   - 인천
   - 대구
   - 대전
   - 광주
   - 울산
   - 제주

Each region should show representative lots as direct `/wiki/$slug` links. Region route creation can come later.

4. Practical criteria content
   - 요금 확인
   - 운영시간 확인
   - 주차면 수 확인
   - 난이도/후기 확인

This should be concise and tied to the actual browse sections.

## Data Strategy

Extend `fetchWikiHome` to return:

- `easy`: top 12
- `spacious`: top 12
- `free`: top 12
- `popular`: top 16
- `recentlyUpdated`: top 12 based on enriched fields or stats update timestamp if available
- `regions`: representative lots per region

Ranking preference:

- pages with `web_sources`
- curation reason
- reviews
- total spaces
- high final score

## Acceptance Criteria

- `/wiki` SSR HTML has exactly one useful `h1`.
- `/wiki` body text is no longer thin.
- `/wiki` exposes at least 80 internal `/wiki/...` links in SSR HTML.
- `bun run build` succeeds.
- `bun run seo-audit --url=https://easy-parking.xyz/wiki` should improve after deploy; local validation can use SSR HTML counts because canonical points to production.

## Follow-Up

- Add `/wiki/region/$region` SSR routes if region sections show value.
- Add `/wiki/category/$category` for shopping malls, markets, parks, stations after category data is stable.
- Feed GSC exports into `seo-audit` to compare hub-linked pages against indexed/not-indexed status.
