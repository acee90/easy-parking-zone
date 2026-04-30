# CLAUDE.md

## Commands

```bash
bun install              # Install dependencies
bun --bun run dev        # Dev server
bun --bun run build      # Production build
bun --bun run test       # Run tests (vitest)
bun run deploy           # Build + deploy to Cloudflare Workers
bun run cf-typegen       # Generate Cloudflare Worker types
```

Add shadcn components with: `npx shadcn@latest add <component>`

## References

### references
- [Architecture](docs/references/ARCHITECTURE.md) — 기술 스택, 디렉토리 구조, 데이터 흐름
- [Quality Score](docs/references/QUALITY_SCORE.md) — 코드 품질 기준, 테스트 전략, 기술 부채
- [Reliability](docs/references/RELIABILITY.md) — 운영 안정성, 모니터링, 장애 대응
- [Review](docs/references/REVIEW.md) — 코드 리뷰 체크리스트, PR 기준
- [Security](docs/references/SECURITY.md) — 인증, 데이터 보호, 취약점 관리
- [Crawling Pipeline](docs/references/poi-pipeline-v2.md) — 크롤링 파이프라인 현행 아키텍처
- [Nearby Places Pipeline](docs/references/nearby-places-pipeline.md) — 주변 장소 AI 추출 파이프라인
- [Web Sources AI Summary](docs/references/web-sources-ai-summary.md) — web_sources.ai_summary 재추출 스킬

### product-specs
- [Product Sense](docs/product-specs/PRODUCT_SENSE.md) — 서비스 비전, 핵심 기능, 난이도 체계

### archive
- [Scoring Algorithm](docs/archive/2026-03/crawlers/parking-scoring-algorithm.md) — 스코어링 알고리즘 설계

> 폴더 안내: `design-docs/` (디자인) · `exec-plans/` (구현 계획) · `product-specs/` (제품 스펙) · `references/` (운영 문서) · `archive/` (이전 작업)

## Behavioral Guidelines

1. **Think Before Coding** — 가정을 명시하고, 불확실하면 질문. 여러 해석이 있으면 제시.
2. **Simplicity First** — 요청된 것만 구현. 추측성 추상화/설정/에러 핸들링 금지.
3. **Surgical Changes** — 요청과 무관한 코드 수정 금지. 내가 만든 orphan만 정리.
4. **Goal-Driven Execution** — 검증 가능한 목표 정의 후 루프.
