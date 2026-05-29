# `web_sources_missed` 기반 신규 주차장 추가 계획 — 2026-05-28

> 목표: `web_sources_missed`에 쌓인 "웹 근거는 있으나 기존 `parking_lots`에 매칭되지 않은 주차장 후보"를 네이버지도 우선, 카카오지도 fallback/교차검증으로 검증해, 실제 존재하지만 우리 DB에 없는 주차장을 안전하게 `parking_lots`에 추가한다.

---

## 현황

Remote D1 `parking-db` 기준:

```sql
SELECT COUNT(*) AS count FROM web_sources_missed;
```

| 항목 | 건수 |
|---|---:|
| `web_sources_missed` 총계 | **13,265** |

소스 분포:

| source | 건수 |
|---|---:|
| `ddg_search` | 6,527 |
| `naver_blog` | 5,182 |
| `naver_cafe` | 1,549 |
| `tistory_blog` | 7 |

상위 `missed_lot_name` 샘플에는 `성남도시개발공사`, `지하`, `강남역`, `플레이스뷰`, `서울시` 같은 범용/노이즈 이름이 포함된다.

→ `missed_lot_name`만으로 `parking_lots`에 바로 넣으면 오삽입 위험이 높다. 반드시 장소검색 검증과 기존 lot 중복 검사를 거친다.

---

## 원칙

1. `web_sources_missed`는 원본/증거 테이블로 보존한다.
2. 신규 주차장 추가는 별도 후보 테이블에서 `pending → searched → approved/rejected/applied` 상태로 추적한다.
3. **하이브리드 채택 (2026-05-28 결정): "네이버로 찾고, 카카오로 확정".** 네이버 Local Search로 존재·이름·주소·카테고리를 1차 검증하고, 신규 lot 확정(안정적 `KA-` ID + WGS84 좌표)은 카카오 Local 키워드검색으로 처리한다. 네이버 placeId 내부 엔드포인트(undocumented 스크래핑)는 MVP에서 제외한다. MVP 테스트 후 로직을 보완·업그레이드한다.
4. 기존 `parking_lots` 반경 내 중복 후보는 신규 insert하지 않고 기존 lot 재연결 후보로 처리한다.
5. 요금/운영시간/면수는 신규 등록 단계에서 무리하게 채우지 않는다. 1차 목표는 "존재하는 주차장의 좌표/주소 확보 + web source 재연결"이다.

---

## 제안 스키마

### 1. Discovery 후보

```sql
CREATE TABLE parking_lot_discovery_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  missed_lot_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  evidence_count INTEGER NOT NULL,
  source_count INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  reject_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_discovery_candidates_status
  ON parking_lot_discovery_candidates(status, evidence_count);

CREATE INDEX idx_discovery_candidates_name
  ON parking_lot_discovery_candidates(normalized_name);
```

### 2. 장소검색 결과

```sql
CREATE TABLE parking_lot_place_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  discovery_candidate_id INTEGER NOT NULL REFERENCES parking_lot_discovery_candidates(id),
  provider TEXT NOT NULL, -- kakao | naver
  provider_place_id TEXT,
  name TEXT NOT NULL,
  address TEXT,
  road_address TEXT,
  lat REAL,
  lng REAL,
  phone TEXT,
  category TEXT,
  place_url TEXT,
  confidence REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_place_candidates_status
  ON parking_lot_place_candidates(status, confidence);

CREATE INDEX idx_place_candidates_provider_id
  ON parking_lot_place_candidates(provider, provider_place_id);
```

### 3. Missed 해소 추적

`web_sources_missed`는 삭제보다 해소 상태를 남기는 방향을 우선한다.

```sql
ALTER TABLE web_sources_missed ADD COLUMN resolution_status TEXT;
ALTER TABLE web_sources_missed ADD COLUMN resolved_parking_lot_id TEXT REFERENCES parking_lots(id);
ALTER TABLE web_sources_missed ADD COLUMN resolved_at TEXT;
```

상태 예:

| status | 의미 |
|---|---|
| `resolved_new_lot` | 신규 lot 생성 후 `web_sources`로 승격 |
| `resolved_existing_lot` | 기존 lot에 재연결 |
| `rejected_noise` | 장소명이 범용/노이즈 |
| `rejected_no_place` | 지도 장소검색 결과 없음 |
| `review_required` | 자동판정 불가 |

---

## 후보 생성 규칙

### 자동 후보 가산점

- `evidence_count >= 2`
- 서로 다른 `source`가 2종 이상
- 이름에 `주차장`, `파킹`, `parking`, `공영`, `민영`, `지하주차장` 포함
- title/content에 동일 장소명 반복
- source가 `naver_blog`이고 주차 경험/진입/요금/혼잡/난이도 문맥 포함

### 보류 또는 reject 후보

- 단일 일반명: `지하`, `주차`, `주차장`, `노상공영`
- 지역/역/기관 단독명: `강남역`, `서울시`, `도봉구`, `성남도시개발공사`
- 검색 서비스/페이지명: `플레이스뷰`
- 주차장이 아니라 시설/지역만 가리키는 이름
- source 1건뿐이고 content가 짧거나 주차장 존재 근거가 약한 경우

초기 MVP는 `evidence_count` 상위 500개를 대상으로 한다.

---

## Lot Name Extraction 개선 트랙

`web_sources_missed` 해소 작업은 신규 lot 추가뿐 아니라 lot name extractor의 회귀 데이터로 사용한다.

현재 missed 상위값에 `지하`, `강남역`, `성남도시개발공사`, `플레이스뷰`, `서울시` 같은 값이 포함되어 있다. 이는 일부 raw에서 "주차장명"이 아니라 일반명/지역명/기관명/페이지명을 `missed_lot_name`으로 추출하고 있다는 신호다.

### 목표

1. 앞으로 쌓이는 `web_sources_missed`의 노이즈 비율을 줄인다.
2. 실제 지도에 존재하는 신규 주차장 후보는 더 잘 보존한다.
3. 네이버지도 검색 결과를 extractor 평가 데이터로 재사용한다.

### 추출 품질 메타

신규 discovery 후보 테이블 또는 별도 평가 테이블에 아래 메타를 남긴다.

```sql
ALTER TABLE parking_lot_discovery_candidates ADD COLUMN extraction_confidence REAL;
ALTER TABLE parking_lot_discovery_candidates ADD COLUMN extraction_reason TEXT;
ALTER TABLE parking_lot_discovery_candidates ADD COLUMN candidate_type TEXT;
```

`candidate_type`:

| type | 의미 |
|---|---|
| `parking_lot_name` | 주차장명으로 바로 검색 가능한 후보 |
| `facility_name` | 시설명이며 `{시설명} 주차장` 검색이 필요한 후보 |
| `region_name` | 지역/역/행정구역 단독명 |
| `organization_name` | 공사/기관/운영사명 |
| `generic_term` | `지하`, `주차`, `노상공영` 같은 일반명 |
| `page_or_service` | `플레이스뷰` 같은 페이지/서비스명 |
| `unknown` | 자동 분류 불가 |

### Negative filter

extractor 단계 또는 discovery 후보 생성 단계에서 아래 값을 감점/보류한다.

- 단독 일반명: `지하`, `주차`, `주차장`, `노상공영`, `민영`
- 지역/역 단독명: `강남역`, `대전역`, `서울시`, `도봉구`, `대구 달서구`
- 기관/운영사 단독명: `성남도시개발공사`, `광주도시관리공사 통합관리`
- 페이지/서비스명: `플레이스뷰`, `미래한강본부 통합포털`
- 너무 긴 설명형 이름: `노인일자리 채용공고 홈페이지 구인구직 공공근로`

처리:

- `generic_term`, `region_name`, `page_or_service`는 자동 장소검색 대상에서 제외
- `facility_name`, `organization_name`은 `{후보명} 주차장` 단독 검색보다 title/content에서 시설명+지역명 재추출 후 검색
- `parking_lot_name`만 자동 승인 후보 풀로 이동

### Positive signal

아래 패턴은 `parking_lot_name` confidence를 올린다.

- `OO주차장`, `OO공영주차장`, `OO민영주차장`, `OO지하주차장`
- `OO파킹`, `OO Parking`, `투루파킹 OO`
- `제1주차장`, `제2주차장`, `부설주차장`이 시설명과 함께 등장
- title과 content 양쪽에 같은 후보명이 반복
- 주차 관련 문맥이 근처에 있음: `요금`, `입구`, `출구`, `만차`, `혼잡`, `경사`, `좁다`, `주차권`, `정산`

### 네이버지도 검색 결과를 평가셋으로 사용

장소검색 결과를 extractor 개선 label로 환류한다.

| 검색 결과 | extractor label |
|---|---|
| 네이버지도에서 동일/유사 주차장 결과 1개 확정 | positive |
| 네이버지도에서 주차장 결과는 있으나 이름이 시설명 중심 | weak_positive |
| 결과가 여러 개라 disambiguation 필요 | ambiguous |
| 주차장 결과 없음 | negative |
| 지역/기관/페이지 결과만 나옴 | extraction_noise |

초기 500 후보의 검색 결과를 `data/eval-lot-name-extraction-YYYYMMDD.csv`로 저장해 회귀 테스트셋으로 사용한다.

필수 컬럼:

```text
raw_missed_lot_name, normalized_name, candidate_type, extraction_confidence,
source_count, evidence_count, naver_query, naver_result_name,
naver_result_category, naver_result_address, label, notes
```

### extractor 개선 적용 지점

1. `web_sources_missed` insert 직전
   - `missed_lot_name`이 명백한 noise면 missed에 넣지 않고 raw 상태만 남길지 검토
   - 단, 초기에는 데이터 손실 방지를 위해 insert는 유지하고 `candidate_type`만 낮게 표시
2. discovery 후보 생성
   - `candidate_type`과 `extraction_confidence`로 장소검색 대상 선별
3. lot-match 재처리
   - `facility_name`으로 분류된 경우, 기존 `parking_lots` 매칭도 `{시설명} 주차장` 후보를 함께 고려
   - **좌표/지역 기반 보조 매칭** — 이름매칭 실패분도 장소검색 좌표가 기존 lot ≤60m면 그 lot에 재연결(re-link)하여 missed로 보내지 않음. MVP 실측에서 `all_existing` 타입1(≈56%)이 이 경로로 회수 가능 ([Stage C-3](#stage-c-3--all_existing의-두-종류-분석) 참조).

### 성공 기준

초기 500 후보 기준:

- `generic_term`/`region_name`/`page_or_service` 자동 검색 제외율 95% 이상
- `parking_lot_name`으로 분류된 후보의 네이버지도 주차장 hit rate 70% 이상
- 신규 missed 유입분 중 명백한 노이즈 상위 20개가 반복 출현하지 않을 것
- extractor 변경 전후 샘플 100건에서 실제 주차장명 누락 증가 없음

---

## 장소검색 전제 (API / ID / 좌표 현실)

> 코드베이스 검증(2026-05-28) 결과 아래 전제가 확정됨. 구현 전 반드시 반영한다.

- **Naver 우선 정책 유지.** 단, 가용 API에 따라 검증과 ID 채번이 분리된다.
- **Naver Local Search OpenAPI**(`openapi.naver.com/v1/search/local.json`)는 존재 검증·이름·주소·카테고리·좌표(`mapx/mapy`)·전화번호만 반환하고 **placeId/regionId를 주지 않는다.** 따라서 이 API 결과만으로는 기존 `NV-{placeId}_{regionId}` ID를 만들 수 없다.
  - 기존 `NV-*` ID는 시드 데이터(`scripts/hell-parking-list.json`)에서 유입된 값이며, 이를 생성하는 활성 코드는 현재 없다. 이 형식은 Naver 지도 내부 검색(`map.naver.com/p/api/search/allSearch` 류)이 반환하는 placeId+regionId 기반이다.
  - 클라이언트 코드는 `scripts/archive/register-1010-unmatched.ts`의 `searchLocal()`이 유일하며 archive(legacy) 상태 → 활성 `scripts/lib/`로 승격 필요.
- **ID 채번 정책(아래 Insert 정책 참조):** Local Search만으로 확정한 신규 lot은 `NV-` 형식을 만들 수 없으므로 별도 ID 스킴이 필요하다. placeId가 필요하면 Naver 지도 내부 검색 엔드포인트(undocumented)로 placeId+regionId를 별도 확보하는 단계를 둔다.
- **좌표 변환 필수:** Naver Local Search의 `mapx/mapy`는 WGS84 경위도가 아니다(정수 스케일/KATECH 계열). `parking_lots.lat/lng`(REAL, WGS84)로 넣기 전 변환 로직이 필요하다.
- **Kakao**는 fallback/교차검증용. 단 현재 `enrich-kakao-place.ts`는 아는 placeId를 Playwright로 스크래핑할 뿐 **이름 검색 기능이 없다.** 이름→장소 검색이 필요하면 Kakao Local 키워드검색 REST API(`dapi.kakao.com/v2/local/search/keyword.json`) 클라이언트를 신규 작성한다. Kakao는 응답 `id`로 `KA-{id}` 채번이 가능하다.
- **신규 스크립트 5종 전부 미존재** → 모두 신규 작성 대상이다.

---

## 장소검색 전략

검색 쿼리는 `missed_lot_name` 단독 사용을 피한다. `title`, `content`, `source_url`에서 지역/시설 힌트를 추출해 조합한다.

쿼리 예:

```text
{missed_lot_name} 주차장
{지역명} {missed_lot_name} 주차장
{시설명} 주차장
{도로명/동명} {시설명} 주차장
```

우선순위 (하이브리드 "네이버로 찾고, 카카오로 확정"):

1. **네이버 Local Search** — 존재·이름·주소·카테고리 1차 검증 (발견 단계)
2. **카카오 Local 키워드검색** — 동일 장소 확정 + `KA-{id}` 채번 + WGS84 좌표 확보 (확정 단계)
3. 네이버 hit + 카카오 hit → 교차검증 통과 시 자동 후보
4. 네이버 hit + 카카오 miss → `review_required` (좌표/ID 확정 수단 부족, MVP에서는 자동 insert 안 함)
5. 네이버 miss → `rejected_no_place` 또는 카카오 단독 검색 후 판단

장소검색 결과 필터:

- 카테고리/이름이 주차장 계열
- 주소 또는 도로명주소 존재
- 좌표 존재
- 이름 유사도 통과
- 기존 `parking_lots`와 반경 30m~80m 내 동일/유사 이름 없음

---

## 중복 판정

신규 insert 전 기존 `parking_lots`를 좌표 기반으로 검사한다.

자동 중복 처리:

- 반경 30m 이내 + 이름 유사도 높음 → 기존 lot
- 반경 80m 이내 + 주소/건물명 유사 → 기존 lot 후보
- 동일 provider id 패턴 존재 → 기존 lot

review 필요:

- 반경 80m 이내 유사 후보가 2개 이상
- 같은 건물에 여러 주차장 후보가 있음
- 카카오/네이버 결과 좌표가 서로 크게 다름

---

## 신규 `parking_lots` Insert 정책

ID (위 "장소검색 전제" 반영):

- **네이버 placeId 확보 가능 시**(지도 내부 검색 경로): 기존 repo의 `NV-{placeId}_{regionId}` 패턴을 따른다.
- **네이버 Local Search OpenAPI만으로 확정한 경우**: placeId가 없어 `NV-*`를 만들 수 없다. → 카카오 교차검증으로 `KA-{kakaoPlaceId}` 채번을 우선하거나, 둘 다 불가하면 `review_required`로 보류한다. (Local Search 결과만으로 placeId 없는 자체 채번 ID를 발급하지 않는다 — 추후 dedup/병합 비용이 큼)
- 카카오만 확정: `KA-{kakaoPlaceId}`
- 네이버/카카오 둘 다 있으면: 검증은 네이버 우선, **ID는 placeId를 안정적으로 확보 가능한 쪽**을 사용한다(현실적으로 Kakao `KA-` 우세). 다른 한쪽은 보조 검증 출처로 `parking_lot_place_candidates`에 저장한다.

> 결론: "네이버 우선"은 **검증·존재확인** 기준으로 유지하되, **ID 채번**은 placeId 확보 가능 여부로 결정한다. placeId 확보 경로(지도 내부 검색)를 구현하지 않는 한, 자동 신규 insert는 Kakao `KA-` 채번에 의존하게 된다.

초기 필드:

```sql
INSERT INTO parking_lots (
  id,
  name,
  type,
  address,
  lat,
  lng,
  total_spaces,
  is_free,
  auto_difficulty_score,
  phone,
  verified_source,
  verified_at,
  created_at,
  updated_at
) VALUES (
  ?, ?, ?, ?, ?, ?,
  0,
  0,
  3.0,
  ?,
  'naver_detail',
  datetime('now'),
  datetime('now'),
  datetime('now')
);
```

`type` 기본값:

- 공영/노상 키워드가 명확하면 `노상` 또는 `노외`
- 그 외 지도 장소 기반 신규 lot은 기본 `부설`
- 불명확하면 review

---

## `web_sources` 재연결

신규 lot 또는 기존 lot 확정 후:

1. `web_sources_missed`의 row를 `web_sources`로 승격
2. `parking_lot_id`를 확정 lot id로 설정
3. `raw_source_id` 유지
4. `web_sources_raw.matched_at`은 이미 설정되어 있더라도 정합성 확인
5. `web_sources_missed.resolution_status/resolved_parking_lot_id/resolved_at` 업데이트

원칙:

- `source_id` unique 충돌 방지를 위해 기존 `web_sources`와 중복 검사
- 같은 raw가 기존 `web_sources`와 `web_sources_missed` 양쪽에 존재하지 않도록 검증
- `web_sources` 변경 후 `parking_lot_stats` 재계산 대상에 enqueue

---

## 구현 단계

### Stage A — 후보 집계 dry-run

스크립트:

```bash
bun run scripts/discover-missed-parking-lots.ts --remote --limit 500 --dry-run
```

출력:

- 후보 수
- reject 노이즈 수
- source 분포
- 상위 후보 샘플

### Stage B — 후보 테이블 적재

```bash
bun run scripts/discover-missed-parking-lots.ts --remote --limit 500 --apply
```

### Stage C — 장소검색

하이브리드 2-step: 먼저 네이버로 발견, 그 hit를 카카오로 확정한다.

```bash
# 1) 네이버로 존재/이름/주소 1차 검증
bun run scripts/search-place-candidates.ts --remote --provider naver --limit 100 --dry-run
# 2) 네이버 hit를 카카오 키워드검색으로 확정 (KA- ID + WGS84 좌표)
bun run scripts/search-place-candidates.ts --remote --provider kakao --confirm --limit 100 --dry-run
```

샘플 hit rate 확인 후 `--apply`. MVP는 네이버 hit + 카카오 confirm 둘 다 통과한 후보만 자동 insert 대상으로 본다.

### Stage D — lot name extraction 평가셋 생성

```bash
bun run scripts/export-lot-name-extraction-eval.ts --remote --limit 500 --out data/eval-lot-name-extraction-20260528.csv
```

네이버지도 검색 결과를 `positive`, `weak_positive`, `ambiguous`, `negative`, `extraction_noise`로 라벨링해 extractor 개선 회귀 데이터로 사용한다.

### Stage E — 자동 승인 후보 리포트

```bash
bun run scripts/report-place-candidates.ts --remote --status pending --min-confidence 0.85
```

리포트 항목:

- 신규 insert 후보
- 기존 lot 재연결 후보
- review 필요 후보
- reject 후보

### Stage F — 신규 lot 적용

```bash
bun run scripts/apply-new-parking-lots-from-candidates.ts --remote --limit 50 --dry-run
```

사용자 승인 후:

```bash
bun run scripts/apply-new-parking-lots-from-candidates.ts --remote --limit 50 --apply
```

### Stage G — 검증

검증 쿼리:

```sql
SELECT resolution_status, COUNT(*)
FROM web_sources_missed
GROUP BY resolution_status
ORDER BY COUNT(*) DESC;

SELECT COUNT(*)
FROM web_sources_missed
WHERE resolution_status IS NULL;

SELECT COUNT(*)
FROM web_sources ws
JOIN web_sources_missed wm ON wm.raw_source_id = ws.raw_source_id
WHERE wm.resolution_status IS NULL;
```

---

## 자동 승인 기준

자동 insert 가능:

- 장소검색 결과가 주차장 카테고리
- 좌표/주소 있음
- 이름 유사도 높음
- 기존 lot 중복 없음
- evidence 2건 이상 또는 서로 다른 source 2종 이상
- confidence `>= 0.85`

자동 기존 lot 재연결 가능:

- 기존 lot 반경 30m 이내
- 이름/주소 유사도 높음
- provider 후보가 기존 lot과 같은 시설로 판단됨

review:

- confidence `0.65 ~ 0.85`
- 좌표는 있으나 이름이 시설명 중심
- 중복 후보가 여러 개
- source 근거가 1건

reject:

- confidence `< 0.65`
- 장소검색 결과 없음
- 범용명/지역명/기관명 단독
- 주차장 카테고리 아님

---

## 리스크

| 리스크 | 대응 |
|---|---|
| `missed_lot_name` 노이즈 | 후보 정제 + review 큐 |
| 기존 lot 중복 생성 | 좌표 반경 + 이름/주소 유사도 검사 |
| 카카오/네이버 결과 불일치 | 둘 다 있으면 cross-check, 불일치 시 review |
| 부설주차장/시설명 혼동 | 카테고리와 이름에 주차장 근거 요구 |
| 요금/운영시간 오염 | 신규 등록 단계에서는 canonical fee/hour 미입력 |
| 대량 적용 후 SEO/스코어 영향 | batch limit 50부터 시작, stats recompute enqueue |

---

## 성공 기준

초기 500 후보 파일럿:

- 자동 신규 lot insert precision 95% 이상
- 기존 lot 중복 생성 1% 미만
- `web_sources_missed` 해소율 10% 이상
- 적용 후 `web_sources`/`web_sources_missed` raw 중복 0건
- 신규 lot 상세 페이지가 최소 주소/좌표/source evidence를 가진 상태로 렌더링

---

## MVP 실측 결과 (2026-05-28)

Stage A + Stage C(Naver 발견) 실행. remote→local sync 후 `web_sources_missed` **13,819건** 기준.

### Stage A — 후보 분류 (12,294개 정규화 후보)

| candidate_type | 후보 수 |
|---|---:|
| facility_name | 8,541 |
| region_name | 3,407 |
| page_or_service | 261 |
| organization_name | 71 |
| **parking_lot_name** | **11** |
| generic_term / unknown | 3 |

- 직접 검색 가능한 `parking_lot_name`은 **11개뿐** — extractor가 주차장명이 아니라 시설/지역명을 추출한다는 가설을 데이터로 확인.
- 분류기 1차 반복: `ADMIN_TAIL_RE`에 `동`/`가` 추가 → 동(洞)·도로 단위 지역명 ~1,100개가 facility_name→region_name으로 정제됨.

### Stage C — Naver 장소검색 (상위 eligible 100개 샘플)

반복하며 분류기를 2회 개선(① 동/가 region 정제 → ② 추출 파편어 필터):

| 지표 | ① 동/가 정제 후 | ② 파편 필터 후 |
|---|---:|---:|
| 주차장 존재율 (negative 제외) | 69% | 72% |
| **단일 확정 후보 (positive+weak)** | 6% | **4%** |
| 다중 lot (ambiguous) | 63% | 68% |
| negative | 31% | 28% |

핵심 결론:
- **noise 필터는 정밀도를 올렸다** — 파편 필터 후 positive 샘플의 false positive(`민간위탁`, `연휴 개방 공공`)가 사라지고 진짜 후보(경주 대릉원·세종 캠핑장·속초 영금정)만 남음.
- **그러나 단일 확정률(~4%)은 필터링으로 못 올린다.** 대부분 후보가 lot이 여러 개인 시설/지역이라 구조적으로 ambiguous(68%)다.
- **가장 큰 레버 두 개:**
  1. **disambiguation** — ambiguous(68%)에서 missed row의 본문 지역/좌표 힌트 + 좌표 근접도로 정확한 lot 1개 선택. 여기가 자동 insert 후보를 늘리는 핵심.
  2. **extractor 품질 개선** — 후보 이름 자체가 정확해야 단일 매칭률이 오른다.
- naive "{이름} 주차장 → 단일 Naver 결과 → 자동 insert" 경로만으로는 MVP precision 95% 달성 불가.

### Stage C-2 — disambiguation + 기존 lot 중복제거 (상위 eligible 100개)

라벨을 목표 지향으로 재정의(`resolved_new`/`ambiguous_new`/`all_existing`/`negative`)하고, ① 기존 `parking_lots` 31,940개와 좌표 중복(≤60m) 제거 ② missed 본문 지역 힌트(구/동/로) + 관련성 게이트로 단일 신규 lot 확정.

| 라벨 | 비율 | 의미 |
|---|---:|---|
| **resolved_new** | **13%** | 단일 신규 lot 확정 (관련성 검증 통과) → 자동 insert 후보 |
| ambiguous_new | 36% | 신규 후보 여러 개, 본문 힌트로 미확정 |
| all_existing | 23% | 주차장 있으나 전부 기존 DB와 중복 |
| negative | 28% | 주차장 결과 없음 |

핵심 결론:
- **dedup이 작동한다** — 주차장 존재(72%) 중 23%p는 이미 우리 DB에 있는 lot. 신규 산출에서 제외해야 정확.
- **관련성 게이트 필수** — "신규 결과 1개"만으로 확정하면 무관 매칭(예: "문경새재"→"수옥폭포") false positive 발생. region_score>0 또는 이름 토큰 일치를 요구하니 제거됨.
- **resolved_new ~13%**가 현재 자동 insert 가능 상한. 상위 eligible ~8,334개 기준 대략 ~1,000개 규모이나, precision은 아직 95% 미달(시장 인근 lot 등 근사 매칭 포함).
- ambiguous_new 36%는 disambiguation 신호 강화 시(좌표 근접도 가중, 이름 유사도 임계) 추가 확보 여지.

### Stage C-3 — `all_existing`의 두 종류 분석

`all_existing`(이미 DB에 있는 lot으로 dedup된 후보)은 단일 성격이 아니다. 좌표 0m·동일 lot으로 매칭된 25건을 "결과 lot명에 후보 토큰 포함 여부"로 갈라보면 **타입1 ≈14 / 타입2 ≈11**.

**근본 원인:** lot-match 단계는 **이름 텍스트 매칭**으로 동작 → 추출된 `missed_lot_name`이 등록 lot명과 표기가 다르면(축약/변형/거친 추출) 좌표상 같은 장소라도 매칭 실패 → missed로 적재. Stage C 좌표 dedup이 "사실 이미 DB에 있다"를 드러냄.

**타입1 — 진짜 re-link 대상 (≈14/25):** 후보가 그 특정 lot을 실제로 가리킴. 블로그도 그 lot 얘기.
```
"경주 대릉원"     → 대릉원황남지구공영주차장  [0m]
"여수 진남관"     → 진남관 노상 공영 주차장   [17m]
"제천 내토전통시장" → 내토전통시장주차장       [7m]
```
→ 신규 insert가 아니라 **web_source를 기존 lot에 재연결**(`resolved_existing_lot`). 그 lot이 리뷰·난이도 콘텐츠를 얻음 = **커버리지 개선**.

**타입2 — 일반/지역 쿼리 우연 매칭 (≈11/25):** 후보가 노이즈(광역지역명·일반명)라 `"{노이즈} 주차장"`이 Naver 인기 lot을 반환. 블로그와 무관.
```
"서울"     → 롯데월드타워몰 주차장        [0m]
"전통시장" → 광명전통시장 공영주차장      [0m]
"제주도"   → 성산포항 공영 주차장         [0m]
```
→ 0m 동일 매칭이라도 블로그가 그 lot 얘기라는 보장 없음. re-link하면 엉뚱한 lot에 무관한 글이 붙음. **애초에 eligible에 들어오면 안 되는 잔여 노이즈.**

**판별 한계(정직):** "결과 lot명에 후보 토큰 포함" 휴리스틱은 거칠다. `"안양"→안양종합운동장`(광역명인데 타입1로 오분류), `"인천 중구 답동성당"→천주교답동성바오로교회공영주차장`·`"서산시 석남동 임시공영"→임시공영주차장`(같은 곳인데 표기/띄어쓰기 차이로 타입2로 오분류). 신뢰성 있는 분리는 **(a) 후보 특이성(특정 시설명 vs 광역/일반명) + (b) 띄어쓰기 무시 fuzzy 이름유사도** 둘 다 필요.

**시사점:**
- `all_existing`은 단일 버킷이 아님 — **절반(타입1)은 커버리지 개선 기회(re-link), 절반(타입2)은 잔여 노이즈(제외 대상).**
- 더 근본적으로 **lot-match에 좌표/지역 기반 보조 매칭**을 넣으면 타입1이 애초에 missed로 안 가고 기존 lot에 바로 붙는다 → missed 유입 자체 감소. 이는 [Lot Name Extraction 개선 트랙](#lot-name-extraction-개선-트랙)과 직결.

### missed 정화 트랙 실행 결과 (2026-05-29)

extractor/노이즈 정리를 먼저 실행해 "진짜 missed"만 남김. `web_sources_missed`에 `resolution_status`(migration 0047) 추가 후 전체 13,819행을 분류+장소검색으로 해소 (`scripts/resolve-missed.ts`, Naver 8,334 호출). **local·remote 동일 적용.**

| resolution_status | 행 | 의미 |
|---|---:|---|
| rejected_no_place | 6,361 | 장소검색 결과 없음 (대부분 블로그 제목 파편) |
| rejected_noise | 5,027 | 분류 노이즈(지역/일반/페이지/파편) |
| resolved_existing_lot | 910 | 이미 DB에 있음 → 재연결 마커(+lot_id) |
| review_required | 899 | 신규 후보 다수(ambiguous) |
| **NULL (active)** | **622** | 진짜 신규 후보(473) + org 보류(70) + 잔여 |

**결과: active missed 13,819 → 622행 (95% 정화).** 신규 lot 추가의 입력은 이제 NULL(active) 622행 ≈ resolved_new 473후보.

**forward 예방:** `run-pipeline-149.ts` lot-match 두 지점에 노이즈명 필터 추가(`isNoiseLotName`) → 미래 크롤이 노이즈를 missed로 재적재하지 않음(`match_fail_reason='noise_name'`). 좌표 기반 보조매칭(type1 예방)은 파이프라인에 지오코딩 API 추가가 필요해 별도 검토로 보류.

**공유 lib:** 분류 로직 `scripts/lib/missed-classify.ts`, 장소판정 로직 `scripts/lib/place-match.ts` (discover/search/resolve 공유).

**알려진 한계:** `resolved_existing_lot`에 관련성 게이트 미적용 → 일부 false re-link(예: "안양"→안양종합운동장). 단 현재는 마커만 세팅, 실제 web_sources 링크 생성은 후속 단계라 피해 적음.

### lot-match 좌표회수 eval (2026-05-29, measure-first)

`scripts/eval-lot-match-recovery.ts` — resolution_status로 stratified 샘플(N=200) → baseline(현행 이름기반 `pickBestLot`) vs 좌표회수(`place-match.resolvePlace`) 비교. 샘플 fixture: `data/eval-lot-match-sample-20260529.json`(수동 검수용).

| stratum (silver) | baseline 매칭 | 좌표회수 |
|---|---:|---|
| resolved_existing_lot | 2/40 (5%) | 동일 lot 회수 **37/40 (92%)** → **lift +35** |
| null_active (진짜 신규) | 6/40 | existing 0 (오매칭 없음) / new 31 |
| rejected_no_place | 4/40 | negative 40/40 |
| rejected_noise | 1/40 | **existing 17/40 (42%)** ← precision 위험 |
| review_required | 8/40 | ambiguous 39/40 |

핵심 결론:
- **좌표회수는 recall을 크게 올린다** — 이름매칭이 놓친 기존 lot을 5%→92%로 회수(lift +35/40). 이름표기 불일치 문제를 좌표가 해결.
- **precision은 진짜 신규/no_place에서 깨끗** (existing 오매칭 0).
- **유일한 precision 위험은 노이즈명** — `rejected_noise`의 42%가 기존 lot으로 오회수("서울 주차장"→인기 lot). → **좌표회수는 반드시 노이즈 필터 통과 후에만 적용**. Phase 3 forward 노이즈 필터가 이를 차단(노이즈명은 recovery 단계에 도달 안 함).
- baseline vs recovery 비교는 비순환적(서로 다른 로직). silver 라벨이 place-match 산출이라 동어반복 우려가 있으나, baseline 대비 lift와 stratum별 동작 특성은 독립적으로 유의미.

**AI 이름추출 변형 측정 (haiku 서브에이전트, 동일 N=200):** dump한 샘플을 haiku로 깨끗한 검색명 추출(비어있지않음 138/빈값 62) → AI명으로 좌표회수 재측정 후 키워드명과 비교.

| stratum | 키워드명 동일lot 회수 | AI명 동일lot 회수 |
|---|---:|---:|
| resolved_existing_lot | 37/40 | **22/40 (저하)** |
| rejected_noise (오회수) | 17 | 8 (개선) |

결과: **AI 이름추출은 recall↔precision 트레이드이며 좌표회수에 결합 시 net 손해.**
- AI가 옳은 케이스: 노이즈명("서울","공영노외")을 `""`로 거부 → 우연 매칭(type2) 방지 (precision↑).
- AI가 나쁜 케이스: 진짜 장소를 과특정화/환각("경주 대릉원"→"대릉원 공영주차장"→놓침, "김해공항"→"라운지 주차장" 오독) → 단순 키워드 쿼리가 찾던 lot을 놓침 (recall↓).
- **결론: AI 추출을 좌표회수 경로에 넣지 않는다.** 단순 키워드명 + 좌표회수 + 상류 노이즈 필터(Phase 3) 조합이 더 낫고 저렴. (AI의 noise 거부 효과는 이미 노이즈 필터가 더 싸게 처리.)

**권장 production 매칭 순서:** ① 노이즈 필터(skip) → ② 이름매칭(pickBestLot) → ③ 실패 시 좌표회수(키워드명, place-search) → ④ 그래도 없으면 missed. (AI 이름추출은 미채택 — eval에서 net 손해 확인.)

### 다음 후보 방향

1. Stage A 노이즈 필터 강화(파편어 사전 + 추출 파편 감점) 후 재측정 — *적용·재측정 완료*
2. ambiguous 대상 disambiguation 로직(missed row의 본문/지역 힌트 + 좌표 근접도로 best lot 선택) — *적용 완료*
3. `all_existing` 타입1 → 기존 lot **재연결 경로** 구현 (`resolved_existing_lot`); 타입2 → eligible 진입 차단(노이즈 필터)
4. **lot-match 좌표/지역 보조 매칭** — 이름매칭 실패분을 좌표로 회수해 missed 유입 자체를 줄임 (extractor 트랙과 연계)
5. Kakao confirm 단계는 `resolved_new`에만 적용 → 단일 확정률·precision을 끌어올린 뒤 착수

---

## 후속

- 신규 lot에 대해 Kakao detail / Naver Place detail 기반 기본정보 보강
  - 운영시간, 전화번호, 요금
  - `total_spaces`는 공공데이터 우선
- 신규 lot의 `parking_lot_stats` 재계산
- sitemap 포함 정책 검토
- missed 후보 중 review_required를 admin/CSV 검수 플로우로 연결
