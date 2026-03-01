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

## Architecture

**TanStack Start** full-stack React app deployed to **Cloudflare Workers**.
서비스명: **쉬운주차** — 전국 주차장의 주차 난이도를 색상(🟢🟡🟠🔴)으로 보여주는 지도 서비스.

- **Framework**: TanStack Start (built on TanStack Router) with SSR enabled
- **Styling**: Tailwind CSS v4 + shadcn/ui (new-york style, zinc base, CSS variables in `src/styles.css`)
- **Map**: Naver Maps (react-naver-maps), 기존 키 재활용
- **Database**: Cloudflare D1 (`parking-db`)
- **Deployment**: Cloudflare Workers via `@cloudflare/vite-plugin` (SSR environment) + wrangler
- **Testing**: Vitest + @testing-library/react (jsdom)

### Routing

File-based routing — routes live in `src/routes/`. TanStack Router auto-generates `src/routeTree.gen.ts` (do not edit). The root layout is in `src/routes/__root.tsx` and uses a `shellComponent` pattern for the HTML document shell.

### Path Alias

`@/*` → `./src/*` (configured in both `tsconfig.json` and `vite.config.ts`)

### Key Directories

- `src/components/` — shared components (Header, MapView)
- `src/components/ui/` — shadcn/ui components (auto-generated, do not manually edit)
- `src/lib/utils.ts` — `cn()` utility for merging Tailwind classes
- `src/lib/geo-utils.ts` — 거리 계산, 난이도 색상/라벨 매핑
- `src/hooks/useGeolocation.ts` — 브라우저 위치 감지 훅
- `src/types/parking.ts` — ParkingLot 타입 정의 (주차장 데이터 스키마)

### Difficulty Color Scheme

| Score | Color | Label |
|-------|-------|-------|
| ≤ 2.0 | 🟢 green (#22c55e) | 쉬움 |
| ≤ 3.0 | 🟡 yellow (#eab308) | 보통 |
| ≤ 4.0 | 🟠 orange (#f97316) | 어려움 |
| > 4.0 | 🔴 red (#ef4444) | 매우 어려움 |

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
