# CI Pipeline Planning Document

> **Summary**: PR 시 빌드/테스트/린트를 자동 실행하여 코드 품질 게이트를 구축한다
>
> **Project**: easy-parking-zone
> **Version**: 0.1.0
> **Author**: junhee
> **Date**: 2026-04-02
> **Status**: Draft

---

## Executive Summary

| Perspective | Content |
|-------------|---------|
| **Problem** | PR merge 시 빌드 실패·테스트 미통과 코드가 main에 들어갈 수 있다 |
| **Solution** | GitHub Actions로 PR 이벤트에 build/test/lint를 자동 실행하고, 통과를 merge 조건으로 설정 |
| **Function/UX Effect** | PR 생성 즉시 CI 결과가 표시되어, 리뷰어가 코드 품질을 신뢰할 수 있다 |
| **Core Value** | 깨진 코드의 main 유입을 원천 차단하여 운영 안정성을 확보한다 |

---

## 1. Overview

### 1.1 Purpose

PR 시 자동으로 빌드·테스트·린트를 실행하여, 깨진 코드가 main 브랜치에 merge되는 것을 방지한다.

### 1.2 Background

- 현재 CI가 없어 빌드 실패 코드가 merge될 위험이 있다
- 기존 GitHub Actions는 Claude Code Action(이슈 응답)과 Claude Code Review(PR 리뷰)만 존재
- 테스트 6개 파일이 있지만 PR 시 자동 실행되지 않음
- Biome 린터 미설정 상태로, 코드 스타일 강제 수단이 없음

### 1.3 Related Documents

- GitHub Issue: [#65](https://github.com/acee90/easy-parking-zone/issues/65) — CI 파이프라인 구축
- GitHub Issue: [#66](https://github.com/acee90/easy-parking-zone/issues/66) — 테스트 보강
- GitHub Issue: [#67](https://github.com/acee90/easy-parking-zone/issues/67) — Biome 린터 도입
- GitHub Issue: [#68](https://github.com/acee90/easy-parking-zone/issues/68) — 번들 최적화
- Quality Score: [docs/QUALITY_SCORE.md](../QUALITY_SCORE.md)

---

## 2. Scope

### 2.1 In Scope

- [x] GitHub Actions 워크플로우: PR 시 `bun install` → `bun run build` → `bun run test`
- [x] Biome 설치 및 설정 (`biome.json`)
- [x] CI에 `biome check` 린트 단계 추가
- [x] Branch protection rule 설정 (CI 통과 필수)

### 2.2 Out of Scope

- E2E 테스트 (Playwright) — 별도 이슈로 진행
- 테스트 커버리지 보강 (#66) — CI 구축 후 후속
- 번들 사이즈 최적화 (#68) — 독립 이슈
- CD (자동 배포) — 현재 `bun run deploy` 수동 배포 유지

---

## 3. Requirements

### 3.1 Functional Requirements

| ID | Requirement | Priority | Status |
|----|-------------|----------|--------|
| FR-01 | PR 생성/업데이트 시 CI 워크플로우 자동 실행 | High | Pending |
| FR-02 | `bun install` → `bun run build` → `bun run test` 순차 실행 | High | Pending |
| FR-03 | `biome check` 린트 검사 실행 | High | Pending |
| FR-04 | CI 실패 시 GitHub PR에 실패 상태 표시 | High | Pending |
| FR-05 | Branch protection: CI 통과 없이 merge 불가 | Medium | Pending |

### 3.2 Non-Functional Requirements

| Category | Criteria | Measurement Method |
|----------|----------|-------------------|
| Performance | CI 전체 실행 시간 < 3분 | GitHub Actions 로그 |
| Reliability | Flaky test 0건 | 연속 5회 실행 시 동일 결과 |
| Cost | GitHub Actions 무료 범위 내 | 월 사용량 모니터링 |

---

## 4. Success Criteria

### 4.1 Definition of Done

- [ ] PR 생성 시 CI가 자동 실행된다
- [ ] build, test, lint 3단계 모두 통과해야 merge 가능하다
- [ ] 기존 코드가 Biome 규칙에 맞게 포맷팅되어 있다
- [ ] CI 실패 시 PR에 명확한 에러 표시가 나온다

### 4.2 Quality Criteria

- [ ] CI 실행 시간 3분 이내
- [ ] 기존 6개 테스트 파일 모두 통과
- [ ] Biome lint 에러 0건

---

## 5. Risks and Mitigation

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| 기존 코드가 Biome 규칙 위반 다수 | Medium | High | 초기 일괄 포맷팅 (`biome check --write`) 후 커밋 |
| CI 시간이 3분 초과 | Low | Low | bun 캐싱으로 install 시간 단축 |
| D1 바인딩 테스트 환경 차이 | Medium | Medium | mock 기반 테스트 유지, CI에서 jsdom 환경 사용 |

---

## 6. Architecture Considerations

### 6.1 Project Level Selection

| Level | Characteristics | Selected |
|-------|-----------------|:--------:|
| **Starter** | Simple structure | |
| **Dynamic** | Feature-based, BaaS integration | **V** |
| **Enterprise** | Strict layer separation, microservices | |

### 6.2 Key Architectural Decisions

| Decision | Options | Selected | Rationale |
|----------|---------|----------|-----------|
| CI Runtime | GitHub Actions / CircleCI / GitLab CI | GitHub Actions | 이미 사용 중, 무료, 설정 간편 |
| Package Manager | npm / bun | bun | 프로젝트 표준, 빠른 설치 |
| Linter | ESLint+Prettier / Biome | Biome | 올인원, 빠름, bun과 궁합 |
| Lint 규칙 | recommended / strict | recommended | 점진적 도입, 초기 마찰 최소화 |

### 6.3 워크플로우 구조

```
PR 이벤트 (opened, synchronize, reopened)
  │
  ├── Job: ci
  │   ├── Step: checkout
  │   ├── Step: setup bun
  │   ├── Step: bun install (cache)
  │   ├── Step: biome check
  │   ├── Step: bun run build
  │   └── Step: bun run test
  │
  └── 기존 Job: claude-review (별도 워크플로우, 영향 없음)
```

---

## 7. Convention Prerequisites

### 7.1 Existing Project Conventions

- [x] `CLAUDE.md` has coding conventions section
- [ ] `docs/01-plan/conventions.md` exists — 없음
- [ ] ESLint configuration — 없음
- [ ] Prettier configuration — 없음
- [x] TypeScript configuration (`tsconfig.json`)

### 7.2 Conventions to Define/Verify

| Category | Current State | To Define | Priority |
|----------|---------------|-----------|:--------:|
| **Linting** | 없음 | Biome recommended rules | High |
| **Formatting** | 없음 | Biome formatter (indent, quotes) | High |
| **Import order** | 없음 | Biome organize imports | Medium |

### 7.3 Environment Variables Needed

| Variable | Purpose | Scope | To Be Created |
|----------|---------|-------|:-------------:|
| 없음 | CI는 추가 환경변수 불필요 | - | - |

> 참고: `ANTHROPIC_API_KEY`는 Claude Code Review용으로 이미 설정됨

---

## 8. Implementation Plan

| Step | 작업 | 파일 | Size |
|------|------|------|------|
| 1 | Biome 설치 + 설정 | `biome.json`, `package.json` | S |
| 2 | 기존 코드 일괄 포맷팅 | 전체 src/ | S |
| 3 | CI 워크플로우 작성 | `.github/workflows/ci.yml` | S |
| 4 | 동작 확인 (테스트 PR) | - | S |
| 5 | Branch protection 설정 | GitHub Settings | S |

---

## 9. Next Steps

1. [ ] Design 문서 작성 (`ci-pipeline.design.md`)
2. [ ] 구현 시작 (Step 1~5 순차)
3. [ ] Gap Analysis로 검증

---

## Version History

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 0.1 | 2026-04-02 | Initial draft | junhee |
