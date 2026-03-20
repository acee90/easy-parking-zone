# Plan: 공공데이터포털 주차장 API 동기화

> 작성일: 2026-03-20

## Executive Summary

| 관점 | 내용 |
|------|------|
| **Problem** | 현재 공공데이터 CSV 수동 다운로드 → import-csv.ts 방식은 번거롭고, DELETE ALL → INSERT로 파생 데이터(curation, poi_tags 등)가 유실될 위험이 있다 |
| **Solution** | 공공데이터포털 REST API를 직접 호출하는 로컬 스크립트로, UPSERT 방식으로 기존 데이터를 보존하면서 신규/변경분만 반영 |
| **Function UX Effect** | `bun run sync-public-data --remote` 한 줄로 ~36K 주차장 데이터 최신화 완료 |
| **Core Value** | 파생 데이터 무손실 동기화 + 신규/폐쇄 주차장 감지로 데이터 신뢰도 유지 |

## 1. 배경

### 현재 방식 (import-csv.ts)
- 공공데이터포털에서 CSV 수동 다운로드 → EUC-KR 디코딩 → D1 import
- **문제점**: `DELETE FROM parking_lots` 후 전체 재삽입 → `is_curated`, `curation_tag`, `featured_source`, `poi_tags` 등 파생 컬럼 유실
- 카카오/네이버 출처(KA-, NV-) 주차장도 함께 삭제됨

### 목표
- 공공데이터포털 API 직접 호출로 CSV 다운로드 단계 제거
- UPSERT 방식으로 파생 데이터 보존
- 신규 추가 / 정보 변경 / 폐쇄 주차장 감지 및 리포트

## 2. API 스펙

- **데이터셋**: 전국주차장정보표준데이터
- **인증**: `DATA_GO_KR_SERVICE_KEY` (URL 인코딩된 서비스키)
- **응답형식**: JSON (`type=json`)
- **페이지네이션**: `pageNo` + `numOfRows` (최대 1000)
- **예상 총 건수**: ~40,000건 → 40페이지 (numOfRows=1000)

### API → DB 필드 매핑

| API 필드 | DB 컬럼 | 비고 |
|----------|---------|------|
| prkplceNo | id | PK |
| prkplceNm | name | |
| prkplceSe | - | 주차장구분 (공영/민영), 현재 미사용 |
| prkplceType | type | 노상/노외/부설 매핑 |
| rdnmadr / lnmadr | address | 도로명 우선, 지번 fallback |
| latitude / longitude | lat / lng | 유효범위 검증 필요 |
| prkcmprt | total_spaces | |
| weekdayOperOpenHhmm | weekday_start | |
| weekdayOperColseHhmm | weekday_end | 오타 주의 (Colse) |
| satOperOperOpenHhmm | saturday_start | |
| satOperCloseHhmm | saturday_end | |
| holidayOperOpenHhmm | holiday_start | |
| holidayCloseOpenHhmm | holiday_end | |
| parkingchrgeInfo | is_free | "무료" → 1, else 0 |
| basicTime | base_time | |
| basicCharge | base_fee | |
| addUnitTime | extra_time | |
| addUnitCharge | extra_fee | |
| dayCmmtkt | daily_max | |
| monthCmmtkt | monthly_pass | |
| phoneNumber | phone | |
| metpay | payment_methods | |
| spcmnt | notes | |

### CSV에 없던 신규 필드 (활용 검토)

| API 필드 | 설명 | 활용 |
|----------|------|------|
| feedingSe | 급지구분 | 요금 참고용 (저장 안 함) |
| operDay | 운영요일 | 향후 활용 가능 |
| pwdbsPpkZoneYn | 장애인전용주차구역 보유 | 필터 기능 확장 시 활용 |
| referenceDate | 데이터기준일자 | 동기화 로그용 |
| institutionNm | 관리기관명 | 저장 안 함 |

## 3. 구현 계획

### 스크립트: `scripts/sync-public-data.ts`

```
1. API 전체 페이지 순회 → 메모리에 수집
2. DB 기존 공공데이터 주차장 조회 (id NOT LIKE 'KA-%' AND id NOT LIKE 'NV-%')
3. 비교: 신규 / 변경 / 폐쇄 분류
4. UPSERT SQL 생성 (파생 컬럼 보존)
5. 리포트 출력
```

### UPSERT 전략

```sql
INSERT INTO parking_lots (id, name, type, address, lat, lng, ...)
VALUES (?, ?, ?, ?, ?, ?, ...)
ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  type = excluded.type,
  address = excluded.address,
  lat = excluded.lat,
  lng = excluded.lng,
  total_spaces = excluded.total_spaces,
  weekday_start = excluded.weekday_start,
  -- ... 공공데이터 필드만 업데이트
  updated_at = datetime('now')
  -- is_curated, curation_tag, featured_source, poi_tags 등은 건드리지 않음
```

### 변경 감지 로직

| 구분 | 조건 | 처리 |
|------|------|------|
| **신규** | API에 있고 DB에 없음 | INSERT |
| **변경** | API와 DB 값 다름 (이름, 주소, 요금 등) | UPDATE (파생 컬럼 보존) |
| **동일** | 차이 없음 | SKIP |
| **폐쇄 의심** | DB에 있고 API에 없음 | 리포트에만 기록 (자동 삭제 안 함) |

### 실행 옵션

```bash
bun run sync-public-data              # 로컬 D1
bun run sync-public-data --remote     # 리모트 D1
bun run sync-public-data --dry-run    # 변경사항만 출력, DB 미반영
```

### 에러 처리

- API 에러코드 `00` 외: 에러 메시지 출력 후 중단
- 쿼터 초과 (`22`): 경고 출력, 수집된 데이터까지만 처리
- 네트워크 실패: 3회 재시도 (exponential backoff)
- 좌표 무효 (위도 33~39, 경도 124~132 범위 밖): 스킵 + 로그

### Rate Limiting

- 페이지당 1000건, 딜레이 300ms
- 총 ~40페이지 → 약 12초 소요

## 4. 산출물

| 파일 | 용도 |
|------|------|
| `scripts/sync-public-data.ts` | API 동기화 스크립트 |
| `package.json` | `"sync-public-data"` 스크립트 추가 |

### 실행 후 리포트 (stdout)

```
=== 공공데이터포털 동기화 ===
API 수집: 38,245건 (40페이지)
DB 기존 (공공데이터): 36,250건

신규 추가: 1,823건
정보 변경: 2,456건
동일 (스킵): 31,971건
폐쇄 의심 (API 미존재): 172건

처리 완료: 4,279건 UPSERT
```

## 5. 성공 기준

1. API 호출 → 전체 데이터 수집 성공 (에러 없이 완주)
2. UPSERT 후 파생 컬럼(`is_curated`, `curation_tag`, `featured_source`, `poi_tags`) 보존 확인
3. `--dry-run`으로 변경 예정 내역 사전 확인 가능
4. 카카오/네이버 출처 주차장(KA-, NV-) 영향 없음

## 6. 구현 순서

```
1. API 호출 + 페이지네이션 로직 → verify: 전체 건수 수집 확인
2. DB 기존 데이터 조회 + 비교 로직 → verify: 신규/변경/동일/폐쇄 분류 정확
3. UPSERT SQL 생성 + 실행 → verify: 파생 컬럼 보존, --dry-run 동작
4. 리포트 출력 → verify: 결과 요약 정확
```
