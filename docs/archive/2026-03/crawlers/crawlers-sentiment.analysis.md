# crawlers-sentiment Analysis Report

> **Feature**: 키워드 기반 감성분석 정확도 개선 (#60)
> **Date**: 2026-03-26
> **Match Rate**: 100%

## Executive Summary

| 항목 | 값 |
|------|-----|
| Feature | 감성분석 키워드 감쇠 (#60) |
| Match Rate | 100% (11/11 items) |
| Files Changed | 2 (sentiment.ts, eval-sentiment.ts) |
| Lines Changed | ~8 (sentiment.ts) + ~80 (eval-sentiment.ts rewrite) |

| 관점 | 내용 |
|------|------|
| Problem | 키워드 1개 매칭 시 극단값(1.0/4.8)으로 치우침, AI 대비 17% 큰 차이 |
| Solution | matchCount 기반 감쇠로 키워드 적을 때 중립(3.0) 방향 당김 |
| Function UX Effect | 평균 차이 0.38→0.25, 큰 차이(≥1.5) 5건→1건 |
| Core Value | 초보 운전자에게 더 정확한 난이도 정보 제공 |

## Gap Analysis

### sentiment.ts — DAMPING 구현

| Plan 항목 | 스펙 | 구현 (라인) | 상태 |
|-----------|------|------------|------|
| DAMPING map | `{ 1: 0.5, 2: 0.7 }` | L395 | ✅ |
| Fallback 3+ | `1.0` | `?? 1.0` (L396) | ✅ |
| 감쇠 공식 | `3.0 + (scaled - 3.0) * damping` | L397 | ✅ |
| 삽입 위치 | L392-393 스케일 변환 후 | L394-398 | ✅ |
| Clamp [1.0, 5.0] | (기존 패턴) | L398 | ✅ |

### eval-sentiment.ts — 비교 스크립트

| Plan 항목 | 스펙 | 구현 | 상태 |
|-----------|------|------|------|
| 고정 샘플 | `ORDER BY ws.id` | L87 | ✅ |
| 이전 점수 | DB `sentiment_score` | L103 | ✅ |
| 이후 점수 | `analyzeSentiment()` | L100 | ✅ |
| AI 점수 | Claude Haiku | L106-111 | ✅ |
| 평균 차이 통계 | before/after | L136-137 | ✅ |
| 큰 차이 통계 | ≥1.5 비율 | L138-139 | ✅ |

### 검증 결과 (실행 완료)

| 지표 | 이전 | 이후 | 판정 |
|------|------|------|------|
| 평균 차이 (AI 대비) | 0.38 | 0.25 | ✅ 34% 개선 |
| 큰 차이 ≥1.5 | 5/30 (17%) | 1/30 (3%) | ✅ 80% 감소 |
| 키워드 3개+ 영향 | - | 0건 (샘플 내 해당 없음) | ✅ |

## Match Rate

```
Overall: 100% (11/11)
  ✅ Match:    11 items
  ❌ Gap:       0 items
```
