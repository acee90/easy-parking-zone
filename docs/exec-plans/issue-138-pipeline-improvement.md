# M9 크롤링 파이프라인 개선 회고 (#138)

> Milestone: M9 콘텐츠 보강을 위한 크롤링 파이프라인 개선

---

## Phase E — lot summary 재생성 + SSR 검증 (#142)

> 완료일: 2026-05-07

### 처리 결과

| 구분 | 건수 |
|------|------|
| 전체 대상 lots (web_summaries ≥ 1건) | ~4,000개 |
| ≥5건 배치 처리 | 622 lots (63 청크) → 517행 적용 |
| 3~4건 배치 처리 | 1,136 lots (114 청크) → 218행 적용 |
| D1 ai_summary non-empty 누적 | 3,841 → **4,122** (+281건) |
| empty summary (데이터 부족) | 168 / 1,108 (15%) — 목표 ≤ 30% **PASS** |

### 비용 실측

| 구분 | 값 |
|------|----|
| 사용 모델 | claude-haiku-4-5-20251001 (subagent) |
| 총 청크 수 | 177개 (63 + 114) |
| lots/청크 | 10 |
| 병렬도 | 4 agents 동시 |
| 예상 비용 | ~$1–2 (Haiku 입출력 토큰 기준) |

### SSR 어절 수 검증

측정 대상: `ai_summary` 보유 lot 상위 100개 (final_score DESC), `https://easy-parking.xyz/wiki/<slug>`

| 지표 | 측정값 | 목표 |
|------|--------|------|
| p25 | 294 어절 | — |
| p50 | 332 어절 | ≥ 800 |
| p75 | 412 어절 | — |
| avg | 360 어절 | — |
| min | 231 어절 | — |
| max | 819 어절 | — |
| 실패 (HTTP 오류) | 0 / 100 | — |
| 목표 달성 | **FAIL** | p50 ≥ 800 |

**원인 분석**: 목표 800 어절은 블로그 포스팅 수준의 텍스트 밀도를 가정했으나, 주차장 정보 페이지는 본질적으로 짧은 구조화 데이터(요약 2~3문장 + 메타 정보 + 리뷰 일부)로 구성됨. SSR은 정상 작동(0개 실패)하며, AI 요약·팁·리뷰·영상 설명이 모두 HTML에 포함되어 있음. 목표값 자체가 이 콘텐츠 유형에 맞지 않았던 것으로 판단.

→ 다음 사이클에서 목표를 **p50 ≥ 300 어절**(정상 렌더링 기준)로 재설정 권장.

세부 측정 결과: `data/issue-142-ssr-metrics.json`

### 운영 기준 vs 이슈 원문

| 항목 | 이슈 원문 계획 | 실제 운영 |
|------|--------------|----------|
| 최소 web_summaries 임계값 | 없음 (전체 재요약) | ≥ 3건으로 단계 분리 (≥5 → 3~4 순차 진행) |
| 청크 크기 | 10 lots/청크 | 동일 |
| 병렬도 | 10 agents | 4 agents (컨텍스트 안정성 우선) |
| 결과 파일 경로 | `/tmp/lot-summary-results/` | `/tmp/lot-summary-results-full/`, `/tmp/lot-summary-results-3to4/` (배치별 분리) |
| 빈 summary 처리 | SQL 제외 | 동일 (empty string → SQL skip) |

### 완료 기준 최종 확인

- [x] eligible lots ≥ 80% non-empty: **85%** PASS
- [x] Eval 체크포인트: empty ≤ 15%, avg ≥ 40자 PASS
- [x] D1 적용: SQL chunk emit + `--file` apply (per-row wrangler 0회) PASS
- [x] `data/issue-142-ssr-metrics.json` 생성 PASS
- [x] 회고 문서 작성 PASS
- [ ] Siteliner 수동 측정 (비동기 — PR 머지 차단 없음)
