# CI Pipeline Design Document

> **Summary**: GitHub Actions CI 워크플로우 + Biome 린터 설정의 구체적 구현 설계
>
> **Project**: easy-parking-zone
> **Version**: 0.1.0
> **Author**: junhee
> **Date**: 2026-04-02
> **Status**: Draft
> **Planning Doc**: [ci-pipeline.plan.md](../../01-plan/features/ci-pipeline.plan.md)

---

## 1. Overview

### 1.1 Design Goals

- PR 시 build/test/lint 자동 실행으로 코드 품질 게이트 구축
- Biome 도입으로 코드 스타일 일관성 확보
- CI 실행 시간 3분 이내 유지

### 1.2 Design Principles

- 최소 설정: 프로젝트에 이미 있는 bun + vitest 활용, 새 도구 최소화
- 빠른 피드백: bun 캐싱으로 install 시간 단축, lint → build → test 순서로 빠른 실패
- 기존 워크플로우 비간섭: `claude.yml`, `claude-code-review.yml`과 독립

---

## 2. Architecture

### 2.1 워크플로우 구조

```
.github/workflows/
├── ci.yml                    ← 신규 (이 설계 대상)
├── claude.yml                ← 기존 (이슈 @claude 응답)
├── claude-code-review.yml    ← 기존 (PR 리뷰)
└── crawl-naver-place.yml     ← 기존 (크롤링)
```

### 2.2 CI Job 흐름

```
PR Event (opened, synchronize, reopened)
  │
  └── Job: ci (ubuntu-latest)
        │
        ├── 1. actions/checkout@v4
        │
        ├── 2. oven-sh/setup-bun@v2
        │      └── bun-version: latest
        │
        ├── 3. bun install
        │      └── cache: ~/.bun/install/cache (actions/cache)
        │
        ├── 4. biome check (lint + format 검사)
        │      └── 실패 시 여기서 중단 (빠른 피드백)
        │
        ├── 5. bun run build
        │      └── vite build (TypeScript 컴파일 포함)
        │
        └── 6. bun run test
               └── vitest run (6개 테스트 파일)
```

### 2.3 기존 워크플로우와의 관계

| 워크플로우 | 트리거 | 역할 | 간섭 여부 |
|-----------|--------|------|:---------:|
| `ci.yml` | PR open/sync | build + test + lint | - |
| `claude-code-review.yml` | PR open/sync | AI 코드 리뷰 | 없음 (별도 job) |
| `claude.yml` | issue comment | @claude 응답 | 없음 (다른 트리거) |
| `crawl-naver-place.yml` | workflow_dispatch | 크롤링 | 없음 (수동) |

---

## 3. 파일별 상세 설계

### 3.1 `.github/workflows/ci.yml`

```yaml
name: CI

on:
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened]

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Cache bun dependencies
        uses: actions/cache@v4
        with:
          path: ~/.bun/install/cache
          key: bun-${{ runner.os }}-${{ hashFiles('bun.lock') }}
          restore-keys: |
            bun-${{ runner.os }}-

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Lint
        run: bun run lint

      - name: Build
        run: bun run build

      - name: Test
        run: bun run test
```

**설계 결정:**
- `--frozen-lockfile`: CI에서 lockfile 변경 방지
- lint → build → test 순서: lint가 가장 빠르므로 먼저 실행하여 빠른 실패
- `branches: [main]`: main 대상 PR만 CI 실행

### 3.2 `biome.json`

```json
{
  "$schema": "https://biomejs.dev/schemas/2.0.0/schema.json",
  "organizeImports": {
    "enabled": true
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true
    }
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "single",
      "semicolons": "asNeeded"
    }
  },
  "files": {
    "ignore": [
      "node_modules",
      "dist",
      ".wrangler",
      "*.d.ts",
      "worker-configuration.d.ts"
    ]
  }
}
```

**설계 결정:**
- `recommended` rules: 점진적 도입, strict는 추후 검토
- `indentStyle: space`, `indentWidth: 2`: 기존 코드 스타일 유지
- `quoteStyle: single`, `semicolons: asNeeded`: 기존 코드와 일치
- `*.d.ts` ignore: 자동생성 파일 제외

### 3.3 `package.json` 스크립트 추가

```json
{
  "scripts": {
    "lint": "biome check src/",
    "lint:fix": "biome check --write src/",
    "format": "biome format --write src/"
  }
}
```

**설계 결정:**
- `lint`: CI용 (에러만 보고)
- `lint:fix`: 로컬 개발용 (자동 수정)
- `format`: 포맷팅만 별도 실행
- 대상을 `src/`로 한정: scripts/, docs/ 등 불필요한 검사 방지

---

## 4. Implementation Order

| Step | 작업 | 파일 | 의존 |
|------|------|------|------|
| 1 | Biome 설치 | `package.json` | 없음 |
| 2 | Biome 설정 | `biome.json` | Step 1 |
| 3 | 기존 코드 포맷팅 | `src/**` | Step 2 |
| 4 | package.json 스크립트 추가 | `package.json` | Step 2 |
| 5 | CI 워크플로우 작성 | `.github/workflows/ci.yml` | Step 4 |
| 6 | 로컬 검증 | - | Step 5 |
| 7 | Branch protection 설정 | GitHub Settings | Step 6 |

### Step 6: 로컬 검증 체크리스트

```bash
# 1. lint 통과 확인
bun run lint

# 2. build 통과 확인
bun run build

# 3. test 통과 확인
bun run test
```

### Step 7: Branch Protection 설정

GitHub > Settings > Branches > Branch protection rules > main:
- [x] Require status checks to pass before merging
- [x] Require branches to be up to date before merging
- [x] Status checks: `ci` (워크플로우 job 이름)

---

## 5. Test Plan

### 5.1 검증 방법

| 검증 항목 | 방법 | 기대 결과 |
|-----------|------|-----------|
| lint 통과 | `bun run lint` | exit code 0 |
| build 통과 | `bun run build` | exit code 0, dist/ 생성 |
| test 통과 | `bun run test` | 6개 파일 전체 pass |
| CI 동작 | 테스트 PR 생성 | CI job 성공 표시 |
| CI 실패 감지 | 의도적 lint 에러 PR | CI job 실패 표시 |
| merge 차단 | CI 실패 PR에서 merge 시도 | merge 버튼 비활성화 |

### 5.2 테스트 환경 고려사항

- vitest는 `jsdom` 환경 사용 (CI에서도 동일)
- `cloudflare:workers` mock 설정이 `vitest.config.ts`에 있어 CI에서도 작동
- D1 바인딩은 mock 기반이므로 실제 DB 연결 불필요

---

## 6. Risks and Mitigation

| Risk | 대응 |
|------|------|
| Biome 일괄 포맷팅 시 대량 diff 발생 | Step 3을 독립 커밋으로 분리, 리뷰 생략 가능 |
| `bun.lock` 없는 경우 `--frozen-lockfile` 실패 | `bun.lock` 존재 확인, 없으면 `bun install` 후 커밋 |
| Biome가 기존 코드에서 lint 에러 다수 발견 | `recommended` 규칙 중 너무 엄격한 것은 `biome.json`에서 개별 off |

---

## Version History

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 0.1 | 2026-04-02 | Initial draft | junhee |
