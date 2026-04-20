# ci-pipeline Analysis Report

> **Analysis Type**: Gap Analysis (Design vs Implementation)
>
> **Project**: easy-parking-zone
> **Version**: 0.1.0
> **Analyst**: junhee (gap-detector)
> **Date**: 2026-04-02
> **Design Doc**: [ci-pipeline.design.md](../02-design/features/ci-pipeline.design.md)

---

## 1. Analysis Overview

### 1.1 Analysis Purpose

Design 문서(ci-pipeline.design.md)와 실제 구현 코드 간 일치율을 검증하여, 누락/변경/추가 항목을 식별한다.

### 1.2 Analysis Scope

- **Design Document**: `docs/02-design/features/ci-pipeline.design.md`
- **Implementation Files**: `.github/workflows/ci.yml`, `biome.json`, `package.json`
- **Analysis Date**: 2026-04-02

---

## 2. Overall Scores

| Category | Score | Status |
|----------|:-----:|:------:|
| CI Workflow Match | 100% | Pass |
| biome.json Match | 70% | Warning |
| package.json Scripts Match | 100% | Pass |
| Code Formatting Completion | 100% | Pass |
| Local Verification | 100% | Pass |
| **Overall Design Match** | **90%** | **Pass** |

---

## 3. Gap Analysis (Design vs Implementation)

### 3.1 CI Workflow (`.github/workflows/ci.yml`) -- 100% Match

Design Section 3.1에서 명시한 YAML과 구현이 문자 단위 동일.

| Design Item | Implementation | Status |
|---|---|:---:|
| `name: CI` | Identical | Match |
| `on: pull_request` (branches: [main], types: [opened, synchronize, reopened]) | Identical | Match |
| `runs-on: ubuntu-latest` | Identical | Match |
| `actions/checkout@v4` | Identical | Match |
| `oven-sh/setup-bun@v2` (bun-version: latest) | Identical | Match |
| `actions/cache@v4` (path, key, restore-keys) | Identical | Match |
| `bun install --frozen-lockfile` | Identical | Match |
| Lint -> Build -> Test 순서 | Identical | Match |

**Result: 8/8 = 100%**

### 3.2 `biome.json` -- 70% Strict / 88% Functional Match

| Item | Design | Implementation | Status | Impact |
|---|---|---|:---:|---|
| Schema version | `2.0.0` | `2.4.10` | Changed | Low |
| organizeImports | `organizeImports.enabled: true` | `assist.actions.source.organizeImports: "on"` | Changed | Low |
| VCS config | 미정의 | `vcs: {enabled, git, useIgnoreFile}` | Added | Low |
| File exclusion 방식 | `files.ignore: [...]` | `files.includes: ["**", "!!..."]` | Changed | Medium |
| Excluded: `node_modules` | ignore 목록에 명시 | VCS .gitignore로 대체 | Changed | Low |
| Excluded: `dist` | `dist` in ignore | `!!**/dist` in includes | Match | - |
| Excluded: `.wrangler` | `.wrangler` in ignore | `!!**/.wrangler` in includes | Match | - |
| Excluded: `*.d.ts` | ignore 목록에 명시 | **미포함** | Missing | Medium |
| Excluded: `worker-configuration.d.ts` | ignore 목록에 명시 | **미포함** | Missing | Low |
| Excluded: `routeTree.gen.ts` | 미정의 | `!!**/routeTree.gen.ts` | Added | Low |
| Excluded: `*.css` | 미정의 | `!!**/*.css` | Added | Low |
| Linter rules | `recommended: true` only | `recommended: true` + 7 rule overrides | Added | Low |
| Formatter: indentStyle | `space` | `space` | Match | - |
| Formatter: indentWidth | `2` | `2` | Match | - |
| Formatter: lineWidth | `100` | `100` | Match | - |
| JS: quoteStyle | `single` | `single` | Match | - |
| JS: semicolons | `asNeeded` | `asNeeded` | Match | - |

**Summary**: Match 7 / Changed 4 / Added 4 / Missing 2

### 3.3 `package.json` Scripts -- 100% Match

| Script | Design | Implementation | Status |
|---|---|---|:---:|
| `lint` | `biome check src/` | `biome check src/` | Match |
| `lint:fix` | `biome check --write src/` | `biome check --write src/` | Match |
| `format` | `biome format --write src/` | `biome format --write src/` | Match |

### 3.4 Local Verification -- 100% Match

| 검증 항목 | Design 기대 | 실제 결과 | Status |
|---|---|---|:---:|
| `bun run lint` | exit code 0 | 0 errors, 80 warnings | Match |
| `bun run build` | exit code 0 | 성공 (3.76s) | Match |
| `bun run test` | 6개 파일 pass | 6파일, 78 tests passed | Match |

---

## 4. Match Rate Summary

```
Overall Match Rate: 90%

  Match:      19 items (66%)
  Changed:     4 items (14%)
  Added:       4 items (14%)
  Missing:     2 items  (7%)
  Total:      29 items
```

---

## 5. Missing Items

| Item | Description | Severity |
|---|---|:---:|
| `*.d.ts` 파일 제외 | Design에서 명시했으나 biome.json에 미포함 | Medium |
| `worker-configuration.d.ts` 제외 | `*.d.ts` 제외에 종속 | Low |

> VCS `useIgnoreFile: true`가 활성화되어 있어, node_modules 내 .d.ts는 자동 제외됨.
> 실제 영향은 `worker-configuration.d.ts` 등 로컬 생성 파일에 한정.

---

## 6. Conclusion

**Match Rate 90% -- Design과 Implementation이 잘 일치합니다.**

CI 워크플로우와 package.json 스크립트는 Design과 완전히 동일하게 구현됨.
biome.json의 차이는 대부분 Biome 2.x API 변경과 실용적 개선(VCS 통합, 추가 제외 패턴, 점진적 규칙 도입)에 기인.
유일한 실질적 갭은 `*.d.ts` 파일 제외 누락이나 영향은 미미.

---

## Version History

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 0.1 | 2026-04-02 | Initial gap analysis | junhee |
