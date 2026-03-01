# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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

## 기획서

노션 기획서를 기능 구현/계획 수립의 기준으로 참고할 것:
- **URL**: https://www.notion.so/3152d9c5abbf81e39f71c5ab21cd35ec
- 프로젝트 비전, MVP 기능 목록, 데이터 소스 전략, 난이도 평가 시스템, 로드맵 등 상세 기획 포함

## Architecture

**TanStack Start** full-stack React app deployed to **Cloudflare Workers**.
서비스명: **쉬운주차** — 초보운전자를 위한 전국 주차장 난이도 지도 서비스. 난이도를 색상(🟢🟡🟠🔴)으로 한눈에 표시.

- **Framework**: TanStack Start (built on TanStack Router) with SSR enabled
- **Styling**: Tailwind CSS v4 + shadcn/ui (new-york style, zinc base, CSS variables in `src/styles.css`)
- **Map**: Naver Maps (react-naver-maps), 기존 키 재활용
- **Database**: Cloudflare D1 (`parking-db`) — 주차장 데이터 + 리뷰/평점 저장
- **Deployment**: Cloudflare Workers via `@cloudflare/vite-plugin` (SSR environment) + wrangler
- **Testing**: Vitest + @testing-library/react (jsdom)
- **Data Sources**:
  - 공공데이터포털 전국주차장정보표준데이터 (기본 데이터, 월 1회 동기화)
  - 한국교통안전공단 주차정보 API (실시간 잔여면수, v2)
  - 카카오 Local API PK6 카테고리 (보완 데이터)
  - 자체 크라우드소싱 리뷰 (난이도 평가 — 핵심 차별화)

### Routing

File-based routing — routes live in `src/routes/`. TanStack Router auto-generates `src/routeTree.gen.ts` (do not edit). The root layout is in `src/routes/__root.tsx` and uses a `shellComponent` pattern for the HTML document shell.

### Path Alias

`@/*` → `./src/*` (configured in both `tsconfig.json` and `vite.config.ts`)

### Key Directories

- `src/components/` — shared components (Header, MapView)
- `src/components/ui/` — shadcn/ui components (auto-generated, do not manually edit)
- `src/lib/utils.ts` — `cn()` utility for merging Tailwind classes
- `src/lib/geo-utils.ts` — 거리 계산, 난이도 해골 수/라벨 매핑
- `src/hooks/useGeolocation.ts` — 브라우저 위치 감지 훅
- `src/types/parking.ts` — ParkingLot 타입 정의 (주차장 데이터 스키마)

### Difficulty Rating System

높은 점수 = 초보자에게 쉬운 주차장. 5개 항목(진입로, 주차면 크기, 통로 여유, 출차 난이도, 종합 추천도) 각 1-5점.
난이도는 해골(💀) 개수로 표현 — 해골이 많을수록 어려운 주차장.

| Score | Skulls | Label | 설명 |
|-------|--------|-------|------|
| 4.0-5.0 | 💀 | 초보 추천 | 넓고 여유로움, 초보자도 편하게 주차 가능 |
| 2.5-3.9 | 💀💀 | 보통 | 일반적인 주차장, 약간의 주의 필요 |
| 1.5-2.4 | 💀💀💀 | 주의 | 좁거나 복잡함, 경험 필요 |
| 1.0-1.4 | 💀💀💀💀 | 초보 비추 | 매우 좁거나 기계식, 초보자 피하는 게 좋음 |

## Behavioral Guidelines

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.
