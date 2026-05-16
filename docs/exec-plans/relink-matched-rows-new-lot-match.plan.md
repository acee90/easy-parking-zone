# 기존 matched 행 새 lot-match 로직으로 재처리 — 2026-05-15

> **배경 (사용자 정의)**
> run-pipeline의 match 로직이 재배치됨 (plan §4.1: match를 ai-filter 뒤로 이동, 새 `pickBestLot`).
> 기존 `ai_filtered + matched` 행들은 구 로직으로 매칭된 것이라 새 로직 기준으로 재검사 필요.
> 샘플 100건 재검사 결과 **신구 16% SAME / 84% 불일치** → 단순 full_text purge(백필) 불가, **재처리** 결정.
>
> **최종 목표**
> 1. 기존 matched 행을 새 lot-match 로직으로 재매칭 → `web_sources` 재구성
> 2. 재처리 완료 후 `web_sources_raw.full_text` purge → 용량 확보 (~266MB)

---

## 현황 (2026-05-15)

### 사전 완료

- `web_sources` fulltext 4개 컬럼 제거 (migration `0043`, local+remote, schema.ts 반영, 빌드 정상)
  - `full_text`, `full_text_length`, `full_text_status`, `full_text_fetched_at`
  - 의존 인덱스 `idx_ws_fulltext_status`, `idx_ws_filter_v2_pending` 함께 제거
  - 근거: ws.full_text는 잔재(remote 7,967행 중 3행만 값), 활성 cron은 `web_sources_raw`만 조회

### 재처리 대상 (local `web_sources_raw`)

`filter_passed=1 AND ai_filtered_at NOT NULL AND matched_at NOT NULL AND full_text_status='ok' AND full_text 존재`

| 분류 | 건수 |
|---|---:|
| 재처리 대상 합계 | **26,501** |
| └ `web_sources` 연결됨 (raw_source_id) | 5,065 (19%) |
| └ `web_sources_missed` 연결됨 | 1,443 (5%) |
| └ **무링크** (구 경로, ws 미반영) | ~20,000 (76%) |

### 샘플 100건 재검사 (구 vs 새 pickBestLot, 추적 가능 25건 기준)

| 구분 | 비율 |
|---|---:|
| SAME (동일 lot) | 16% |
| CHANGED (다른 lot) | 44% |
| LOST (→ MISSED) | 40% |

> 변경 예시 다수가 구 매칭 오류(off-topic 콘텐츠가 엉뚱한 lot에 매칭)였고 새 로직은 MISSED 처리.
> → 발산이 크지만 새 로직이 더 엄격·정확한 방향으로 추정.

---

## 실행 계획 (local-first, 스테이지별 또는 최종 bulk SQL 적용)

### Stage A — remote→local sync

`web_sources_raw` / `web_sources` / `web_sources_missed` 를 remote에서 dump받아 local 싱크.
이후 모든 처리는 local DB 기준.

### Stage B — ai-results JSON 재구성

1회성 스크립트로 대상 26,501행의 기존 ai-filter 출력을 `ai-results-NN.json`으로 재구성.
**ai-filter(콘텐츠 판정/요약) 재실행 안 함** — 기존 `ai_summary`/`sentiment_score`/`ai_difficulty_keywords` 재사용.
형식: `{ raw_id, lot_id:'', filter_passed:true, removed_by:null, sentiment_score, ai_difficulty_keywords[], summary: ai_summary }`
(lot_id는 lot-match가 `pickBestLot`으로 재계산하므로 빈값)

### Stage C — 구 매칭 정리 + matched_at 리셋 (local)

```sql
DELETE FROM web_sources        WHERE raw_source_id IN (대상);
DELETE FROM web_sources_missed WHERE raw_source_id IN (대상);
UPDATE web_sources_raw SET matched_at = NULL WHERE id IN (대상);
```

### Stage D — lot-match 재실행 (local)

```bash
bun run scripts/run-pipeline-149.ts --stage lot-match --ai-results <dir>/ai-results-01.json --out <dir>
```

→ `match-ai-chunk-NN.sql` (INSERT OR IGNORE web_sources / missed + matched_at) → local 적용.

### Stage E — 검증 (local)

- 신규 matched / missed / 무매칭 분포 집계
- 샘플 점검 (전부 MISSED 등 이상 패턴 없는지)
- 결과 사용자 보고 → remote 적용 승인 대기

### Stage F — remote 일괄 적용 + full_text purge

승인 후 remote에 DELETE + match SQL + matched_at bulk 적용.
이어서 재처리 완료 행 `full_text = NULL` purge → ~266MB 확보.

---

## 결정 확정 (2026-05-15 / 16 갱신)

- **A. ai-filter 재실행 범위** — ✅ 재실행 안 함. ai-filter는 lot-무관 콘텐츠 판정이라 lot 변경 무관 → `filter_passed=true`만 ai-results로 승계. lot-match만 재실행.
- **A-1. ai_summary** — ⚠️ 구 ai_summary는 raw에 없고(ws/missed에만, 26K중 0건 raw) 있어도 구-lot 기준이라 폐기. **ai-results에 summary 미포함(빈값)** → 재매칭 후속 패스에서 새 lot 기준 재생성. **재생성 프롬프트는 run-pipeline single-source-of-truth `AI_SUMMARY_SYSTEM_PROMPT` (`src/server/crawlers/lib/ai-summary-prompt.ts`) 사용** (/regen-web-summary 스킬 아님).
- **A-2. sentiment_score** — ⚠️ 동일 사유(raw에 26,378중 4,958만 존재). **A-1 후속 패스에서 sentiment_score도 함께 재산출** (lot 무관 성질, 동일 프롬프트 경로).
- **B. 무링크 ~21K행** — ✅ 재처리. 원칙: raw에서 `filter_passed` + lot-match 성공 행은 `web_sources`에 반드시 존재. 새 lot-match가 lot 매칭 시 ws, 미매칭 시 web_sources_missed.
- **C. full_text purge** — ✅ **순서 변경**: dump 후 재매칭 *전*에 remote 선purge (사용자 지시).

## 실행 기록 (2026-05-16)

- Stage A 완료: 4 테이블 remote→local dump → isolated `data/relink-20260515/work.sqlite`.
  - wrangler d1 export가 web_sources_raw 692행 누락 → remote에서 직접 fetch 보완. 최종 raw 36,000 = remote 일치, target_with_ft = **26,378**.
- Remote full_text purge 완료 (Stage F에서 분리·선행): 26,378행 `full_text=NULL, full_text_status='purged'`. **remote DB 509MB → 190MB (−319MB)**.
- Stage B 완료: `ai-results-01~06.json` (26,378건, summary 미포함).
- Stage C 완료 (work.sqlite): target ws/missed DELETE + `matched_at=NULL` (잔여 269 ws는 비대상).
- Stage D 완료: lot-match 재매칭 → **matched 15,520 (58.8%) / missed 10,858 (41.2%)** / 합 26,378.
- Stage E 완료: distinct 매칭 lot 7,641 (쏠림 없음), 샘플 정합 양호, 이상 패턴 없음. 41.2% MISSED는 샘플 예측치와 일치(새 로직 엄격화).
- **버그 발견·수정**: `buildMissedLotInsertSql`가 web_sources_missed에 full_text* 적재 → purge 무력화 + 불변식 위반 + scheduled cron 상시 누수. 코드에서 full_text* 컬럼 제거 (web_sources와 동일 원칙). scheduled cron도 동시 해결.
- Stage F SQL 클린 재생성 (`data/relink-20260515/stage-f/`): 1-deletes → 2-ws(15,520) → 3-missed(10,858, full_text 없음) → 4-matched.
- **Stage F 완료**: remote 95개 SQL 파일 순차 적용 성공. remote 검증 — web_sources 19,085 / web_sources_missed 10,869 / purged 26,378 / **DB 182MB**. 샘플 점검: target raw가 ws|missed 정확히 1곳, full_text purged, matched_at set (692 보완분 포함 정상).

## ⚠️ 후속 필수 (full_text 단일본 보존)

- **remote full_text는 purge됨 → `data/relink-20260515/work.sqlite`(+`raw.sql`)가 26,378행 full_text의 유일한 사본.** A-1/A-2 후속(summary + sentiment 재산출, `AI_SUMMARY_SYSTEM_PROMPT` 경로)이 끝나기 전까지 이 디렉토리 삭제 금지.
- `scripts/run-pipeline-149.ts` `buildMissedLotInsertSql` full_text* 제거 — **미커밋 상태**.

## 리스크

- 26K행 재처리는 prod `web_sources` 직접 영향 (remote 적용 직후 라이브 반영)
- web_sources 변경 → `parking_lot_stats` 스코어/AI요약 파생값 재계산 필요 (별도 후속)
- remote D1 용량: 0043으로 일부 확보, 최종 full_text purge가 주요 회수분

## 후속 개선 과제 (이번 작업 종료 후)

- **`searchCandidateLots` O(N) 선형 스캔 개선** — 현재 행마다 `parking_lots` 31,941개 전체를 선형 스캔하며 키워드 substring 매칭 + 상위 후보마다 full_text 재스캔. 26K행 재매칭이 단일 스레드 CPU로 15~30분 소요되는 주원인.
  - 후보: lot명/주소 FTS5 인덱스 도입, 또는 키워드 역색인(토큰→lot id) 사전 구축, 또는 행정구역(시군구) prefilter로 후보 모수 축소.
  - lot-match는 scheduled cron + 본 재처리 양쪽에서 핫패스 → 처리량/비용 직접 영향.
