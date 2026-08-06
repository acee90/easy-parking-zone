# 구현 계획: 전체 주차장 로드뷰 panoId 전수 수집

> ⚠️ **이 계획은 [로드뷰 품질 개선](./roadview-quality-fix.plan.md)으로 대체되었다 (2026-08-03).**
> Phase B spike 결과, 이 계획대로 "좌표 자동 탐색 결과"를 저장하면 지금 화면에 나오는
> 잘못된 로드뷰가 그대로 고정될 뿐이라는 것이 확인되었다.
> 아래 Phase B 결과(SDK 동작·API 형태·재사용 제약·성능 실측)는 유효하므로 그대로 유지한다.
>
> **2026-08-06 추가**: 네이버 클라우드가 **파노라마 호출 결과의 DB 저장은 허용되지 않는다**고
> 공식 답변했다. 이 문서가 전제한 "panoId 저장 후 재사용"은 대체된 것을 넘어 **약관상 불가**다.
> 참고용으로만 남긴다.

## 목표

모든 `parking_lots`를 대상으로 네이버 로드뷰의 `panoId`를 수집하고, 상세 페이지가 매번 주차장 좌표에서 가장 가까운 파노라마를 재탐색하지 않도록 저장된 로드뷰를 우선 표시한다.

수집 결과에는 `panoId`뿐 아니라 네이버가 실제로 선택한 파노라마의 좌표와 촬영일을 함께 저장한다. 이를 통해 주차장 중심 좌표와 로드뷰 위치가 얼마나 떨어져 있는지 확인하고, 이마트 월계점처럼 출입구와 다른 로드뷰가 선택된 사례를 별도로 검수할 수 있게 한다.

## 현재 상태

- 주차장 원본 좌표: `parking_lots.lat`, `parking_lots.lng`
- 상세 페이지 진입점: `src/routes/wiki/$slug.index.tsx`
- 지도/로드뷰 컴포넌트: `src/components/WikiMiniMap.tsx`
- 현재 로드뷰 생성 방식: `new naver.maps.Panorama(..., { position })`
- 현재 처리: `pano_status` 결과만 화면 상태로 사용하고 `panoId`나 실제 파노라마 좌표는 저장하지 않는다.
- 로드뷰 SDK는 브라우저용 Naver Maps JavaScript API의 `panorama` 서브모듈을 사용한다.

네이버 API는 좌표로 가장 가까운 파노라마를 찾고, `getPanoId()`와 `getLocation()`으로 선택된 파노라마의 ID·좌표·촬영일을 조회할 수 있다. 저장된 ID는 Panorama 옵션의 `panoId`로 다시 사용할 수 있다.

참고:

- [Naver Maps Panorama class](https://navermaps.github.io/maps.js.ncp/docs/naver.maps.Panorama.html)
- [Naver Maps panorama tutorial](https://navermaps.github.io/maps.js.ncp/docs/tutorial-Panorama.html)

## 핵심 결정

### 1. 전수 수집은 브라우저 런타임에서 실행

Panorama API가 DOM과 JavaScript 지도 SDK를 필요로 하므로 Cloudflare Worker의 일반 서버 fetch만으로 수집하지 않는다. 별도 호스트 스크립트에서 실제 브라우저 컨텍스트를 열어 Panorama를 생성하고 `pano_status` 이벤트를 기다린다.

구현 시 선택지는 다음 순서로 검토한다.

1. 저장소에 이미 사용 중인 브라우저 자동화 도구가 있는지 확인
2. 없으면 Playwright 기반의 일회성/재실행 가능한 수집기 추가
3. 브라우저 자동화 의존성 추가가 부담되면 관리자용 수집 페이지를 만들고, 페이지에서 일정 단위로 수집

초기 구현에서는 운영 요청마다 브라우저를 띄우는 API가 아니라, 로컬 또는 CI에서 명시적으로 실행하는 배치 수집기를 우선한다.

### 2. 주차장마다 대표 panoId 하나를 저장

현재 제품 요구사항은 주차장 상세 페이지에서 사용할 대표 로드뷰 하나를 결정하는 것이다. 따라서 `parking_lots`에 현재 선택된 대표 파노라마 정보를 저장한다.

후속으로 여러 후보 파노라마, 변경 이력, 수동 검수 이력이 필요해지면 별도 `parking_lot_roadviews` 테이블로 확장한다. 최초 구현에서 이력 테이블까지 만들지는 않는다.

### 3. panoId만 저장하지 않고 실제 파노라마 위치도 저장

주차장 좌표에서 가까운 파노라마를 자동 선택한 결과가 항상 주차장 입구를 의미하지는 않는다. 따라서 다음을 함께 저장한다.

- 원본 주차장 좌표: 기존 `lat`, `lng`
- 선택된 파노라마 ID: `roadview_pano_id`
- 선택된 파노라마 좌표: `roadview_lat`, `roadview_lng`
- 두 좌표 사이 거리: `roadview_distance_m`
- 파노라마 촬영일: `roadview_photodate`
- 마지막 수집 시각과 수집 상태

이 데이터는 자동 표시 여부와 검수 우선순위를 결정하는 근거로 사용한다. 거리 기준은 대표 샘플 수집 후 보정 가능하도록 수집기 옵션으로 둔다.

## 데이터 모델

### Migration

신규 migration 예: `migrations/0048_parking_lot_roadview.sql`

`parking_lots`에 다음 nullable 컬럼을 추가한다.

```sql
ALTER TABLE parking_lots ADD COLUMN roadview_pano_id TEXT;
ALTER TABLE parking_lots ADD COLUMN roadview_lat REAL;
ALTER TABLE parking_lots ADD COLUMN roadview_lng REAL;
ALTER TABLE parking_lots ADD COLUMN roadview_distance_m REAL;
ALTER TABLE parking_lots ADD COLUMN roadview_photodate TEXT;
ALTER TABLE parking_lots ADD COLUMN roadview_status TEXT;
ALTER TABLE parking_lots ADD COLUMN roadview_checked_at TEXT;

CREATE INDEX IF NOT EXISTS idx_parking_lots_roadview_status
  ON parking_lots(roadview_status);
```

상태값은 최소한 다음을 사용한다.

| 상태 | 의미 |
|---|---|
| `available` | 유효한 `panoId`와 파노라마 좌표를 확인함 |
| `unavailable` | 해당 좌표 주변에 표시 가능한 로드뷰가 없음 |
| `needs_review` | 로드뷰는 찾았지만 거리·위치가 의심스러워 수동 확인 필요 |
| `error` | SDK, 인증, 네트워크 또는 수집 중 예외 |

`available` 여부와 자동 표시 여부를 분리해야 한다. 예를 들어 `needs_review`도 상세 페이지에서는 표시할 수 있지만, 운영 검수 대상이라는 사실은 유지한다.

### Drizzle schema

`src/db/schema.ts`의 `parkingLots`에 위 컬럼을 camelCase로 반영한다.

```ts
roadviewPanoId: text('roadview_pano_id'),
roadviewLat: real('roadview_lat'),
roadviewLng: real('roadview_lng'),
roadviewDistanceM: real('roadview_distance_m'),
roadviewPhotodate: text('roadview_photodate'),
roadviewStatus: text('roadview_status'),
roadviewCheckedAt: text('roadview_checked_at'),
```

## 수집기 설계

신규 파일 예: `scripts/collect-roadview-panoid.ts`

### CLI 계약

```text
bun run scripts/collect-roadview-panoid.ts --limit=10 --dry-run
bun run scripts/collect-roadview-panoid.ts --status=missing --limit=500
bun run scripts/collect-roadview-panoid.ts --status=all --concurrency=2 --flush-every=25
bun run scripts/collect-roadview-panoid.ts --lot-id=KA-20562951 --dry-run
```

필수 동작:

- 기본 대상은 `roadview_pano_id IS NULL` 또는 재수집 대상이다.
- `--status=all`은 `available`도 다시 검사하지만 기본값으로 사용하지 않는다.
- `--dry-run`은 D1 UPDATE를 실행하지 않고 결과 리포트만 남긴다.
- `--lot-id`로 이마트 월계점 같은 단일 사례를 재현할 수 있다.
- 처리 결과를 일정 건수마다 SQL 또는 D1 batch로 flush해 중간 실패 후 재개할 수 있게 한다.
- 이미 `available`인 row는 기본 실행에서 건너뛴다.
- `unavailable`과 `error`는 다음 실행에서 무한 반복하지 않도록 재시도 정책을 둔다.

### 한 건 처리 흐름

Phase B 검증 결과를 반영한 흐름이다. 근거는 [Phase B 결과](#phase-b-결과-2026-08-03-샘플-300건--혼합-샘플-9건) 참조.

1. 주차장 `id`, `name`, `lat`, `lng`를 조회한다.
2. 브라우저 페이지에서 Naver Maps SDK와 `panorama` 서브모듈을 로드한다(프로세스당 1회).
3. Panorama 인스턴스를 재사용해 `setPosition()`으로 좌표를 옮긴다(최초 1회만 생성).
4. `pano_status` 이벤트를 최대 3초 기다린다.
5. `OK`이면 `getPanoId()`와 `getLocation()`을 읽는다.
6. `ERROR`이면 `unavailable`로 확정한다. **이때 `getPanoId()`를 읽지 않는다** —
   재사용 인스턴스는 직전 lot의 panoId를 그대로 들고 있다.
7. 3초 안에 이벤트가 오지 않으면 인스턴스를 폐기하고 **새 Panorama로 재시도**한 뒤
   `getPanoId()`를 폴링한다. `null`이면 `unavailable`, 값이 있으면 정상 처리한다.
   (약 0.33%가 이 경로로 들어온다)
8. 선택된 파노라마 좌표와 주차장 좌표의 거리를 계산한다.
9. 결과를 `available` 또는 `needs_review`로 분류한다.
10. SDK/스크립트 예외는 `error`로 저장하고 `roadview_checked_at`을 남긴다.
11. N건마다 알려진 정상 좌표(canary)를 섞어 전체 실패를 조기에 감지한다.

### 거리 계산과 검수

수집기에는 다음 결과를 함께 출력한다.

- 전체 대상 수
- `available`, `unavailable`, `needs_review`, `error` 건수
- 거리 구간별 분포
- 가장 먼 결과와 대표 샘플
- 이름에 `이마트`, `터미널`, `월드컵`, `공원` 등 대형 시설 키워드가 포함된 결과

초기에는 거리 기준을 코드에 영구 고정하지 않는다. 실제 분포를 확인한 뒤 자동 승인 기준을 정하고, 기준 초과 결과는 `needs_review`로 남긴다. 특히 주차장 중심 좌표가 넓은 시설 부지 내부에 있는 경우 거리만으로 올바른 입구 여부를 확정하지 않는다.

### 저장 방식

수집 결과 JSON을 먼저 생성하고, 검증된 결과만 D1에 반영하는 2단계 실행을 기본으로 한다.

```text
1. collect → data/roadview-panoid-YYYYMMDD.json
2. report  → 거리·상태·오류 분포 검토
3. apply   → D1 UPDATE batch 실행
```

초기 smoke test와 소규모 stage에서는 `dry-run`과 실제 반영을 분리한다. SQL 파일을 생성할 경우 값은 반드시 SQL escaping하고, 업데이트 대상은 `id`로 한정한다.

## 상세 페이지 연결

### 데이터 전달

`src/routes/wiki/$slug.index.tsx`에서 주차장 조회 결과의 `roadviewPanoId`와 상태를 `WikiMiniMap`에 전달한다.

### Panorama 초기화 우선순위

1. `roadviewStatus === 'available'`이고 `roadviewPanoId`가 있으면 `panoId`로 초기화
2. 저장된 ID가 없으면 기존 `position: { lat, lng }` 방식으로 fallback
3. 저장된 ID가 만료되었거나 SDK가 오류를 반환하면 현재 좌표 fallback을 시도
4. fallback도 실패하면 기존 로드뷰 없음 상태를 표시

화면에는 저장된 로드뷰의 실제 위치를 별도로 노출하지 않는다. 다만 운영/관리자 검수 화면에서는 주차장 좌표와 파노라마 좌표, 거리를 확인할 수 있어야 한다.

## 단계별 실행

### Phase A — 스키마와 조회 경로

- [ ] migration 추가 및 local D1 적용
- [ ] `src/db/schema.ts` 반영
- [ ] parking lot 조회 타입/쿼리에 로드뷰 필드 포함
- [ ] migration rollback이 필요한 경우를 대비해 적용 전 local/remote 백업 확인

### Phase B — 수집기 spike

- [x] 단일 주차장으로 Panorama 생성과 `pano_status` 대기 검증
- [x] `getPanoId()`와 `getLocation()` 결과 형태 확인
- [x] 이마트 월계점(`KA-20562951`)의 현재 좌표와 선택된 로드뷰 좌표 비교
- [x] 인증 오류, 로드뷰 없음, timeout, 페이지 종료 시 동작 확인
- [x] 브라우저 자동화 도구와 Naver API 호출/쿼터를 소규모로 확인

#### Phase B 결과 (2026-08-03, 샘플 300건 + 혼합 샘플 9건)

**실행 환경**: Playwright 1.58.2(기존 devDependency) + chromium headless. Naver 지도 키는
referrer 허용목록으로 제한되므로 `page.route()`로 `https://easy-parking.xyz` origin을 가장해
SDK를 로드한다. SDK 로드는 약 170~200ms 1회.

**`getLocation()` 반환 형태** — 계획에서 필요로 한 필드가 모두 있다.

```js
{ panoId: "RZdhMrc--OqRsdIe69BJ1A",
  coord: LatLng(37.6261299, 127.061496),
  title: "",                       // 빈 문자열인 경우가 많음
  address: "서울 노원구 월계동",
  photodate: "2025-01-22 10:24:02" } // datetime 문자열 (date 아님)
```

`roadview_photodate`는 `TEXT`로 두되 datetime 전체를 저장한다.

**이마트 월계점(KA-20562951)**: `panoId=RZdhMrc--OqRsdIe69BJ1A`,
로드뷰 좌표 `37.6261299, 127.061496`, 주차장 좌표에서 **57.9m**, 촬영일 2025-01-22.
계획이 가정한 "중심 좌표와 실제 로드뷰 위치 괴리"가 실제로 측정된다.

**거리 분포(성공 299건)**: p50 14.4m · p90 34.4m · p99 125.7m · max 155.4m.
30m 초과 13.4% / 50m 초과 4.0% / 100m 초과 1.7%.
→ `needs_review` 임계값 후보는 **50m**(약 4%) 또는 100m(약 1.7%). 대형 시설은 중심 좌표가
부지 안쪽이라 거리가 커도 정상인 경우가 있어 거리 단독으로 확정하지 않는다.

**성능**: lot당 p50 97ms · p90 179ms · p99 311ms (Panorama 인스턴스 1개 재사용,
`setPosition()`으로 순회). 300건 연속 호출에서 쓰로틀링·차단 징후 없음.
전수 31,994건 추정: 동시성 1에서 약 1.3시간, 2에서 약 0.7시간, 4에서 약 0.3시간.
보수적으로 **동시성 2~3 + 짧은 간격**으로 약 1시간을 잡는다.

**로드뷰 없음**: `pano_status = ERROR`가 30~350ms 안에 빠르게 온다. 대기 비용 거의 없음.

**⚠️ pano_status가 아예 오지 않는 좌표가 있다 (300건 중 1건, 0.33%)**

`101-1-000017`(서울 중구 남대문로 11)은 3회 재시도 모두 `pano_status`가 오지 않았다.
그런데 파노라마 자체는 정상 해석된다 — 500ms 뒤 `getPanoId()`를 읽으면
`o42HQHFhknVNraJ9O960Nw`(서울 중구 남대문로4가, 2014-06-26 20:42 야간 촬영)가 나온다.
`panoType`은 정상 케이스와 동일한 `3`이라 타입으로는 구분되지 않는다.
→ **이벤트만 신뢰하면 안 되고, timeout 시 `getPanoId()` 폴링 fallback이 필요하다.**
전수 기준 약 100건이 여기 해당할 것으로 추정된다.

**🚨 인스턴스 재사용 시 stale 데이터 위험 (수집기 설계의 핵심 제약)**

A(로드뷰 있음) → B(로드뷰 없음)로 `setPosition()` 하면 `pano_status=ERROR`가 오지만
**`getPanoId()`는 A의 값을 계속 들고 있다**(2초 후에도 동일). 즉 재사용 인스턴스에
폴링 fallback을 그대로 붙이면 B에 A의 panoId를 잘못 저장한다.

반면 **새로 만든 인스턴스**를 로드뷰 없는 좌표에 띄우면 `getPanoId()`가 10초 내내 `null`이다.
→ 폴링 fallback은 **fresh 인스턴스에서만** 안전하다. 수집기는 다음 하이브리드로 간다.

1. 기본: 인스턴스 1개 재사용 + `pano_status` 이벤트 (약 100ms, 99.7%가 여기서 끝남)
2. 이벤트 timeout(3초 권장): 인스턴스를 폐기하고 **새 Panorama를 만들어** 재시도 후
   `getPanoId()` 폴링. `null`이면 `unavailable`, 값이 있으면 `available`
3. 어떤 경우에도 실패 직후 다음 lot으로 넘어가기 전에 인스턴스를 정리한다

**인증 오류**: `ncpKeyId=INVALID_KEY_TEST`로도 `maps.js`/`maps-panorama.js`가 로드되고
`pano_status=OK`까지 나온다. 파노라마 탐색은 키 검증을 강제하지 않는 것으로 보인다.
→ (+) 배치 도중 키 문제로 수만 건이 조용히 `unavailable`이 되는 사고는 발생하지 않는다.
→ (−) 인증 실패를 결과로 감지할 수 없으므로, 배치에 **알려진 정상 좌표 canary**를 주기적으로
섞어 전체 실패를 조기에 감지해야 한다.
→ 키 없이도 동작한다는 사실은 약관 검토 필요성을 오히려 높인다. 전수 실행 전 확인 항목 유지.

**panoId 중복**: 299건 중 2쌍이 동일 panoId. 모두 인접 주차장(고강제일시장/고리울동굴시장,
충현 공영주차장/충현어린이공원 공영주차장)이 같은 로드뷰를 공유하는 정상 케이스다.
중복 자체를 오류로 처리하지 않고 리포트에만 남긴다.

**촬영일 분포**: 2026년 221건 / 2025년 58건 / 그 이전 20건. 대부분 최신이다.

### Phase C — 소규모 수집

- [ ] 10건 `dry-run`
- [ ] 10건 실제 저장
- [ ] 상태값, 거리 계산, 재실행 시 skip 동작 검증
- [ ] 대형 시설·민영·공영·부설 주차장을 섞은 샘플의 위치 검수

### Phase D — 전수 백필

- [ ] 누락 대상 전체 수와 대상 목록 snapshot 저장
- [ ] 보수적인 동시성으로 stage별 수집
- [ ] 일정 단위마다 결과 flush
- [ ] 실패/timeout row 재시도
- [ ] `unavailable`과 `needs_review` 분리 리포트 생성
- [ ] 전수 반영 후 상태·거리·panoId 중복·null 분포 확인

### Phase E — 상세 페이지 전환

- [ ] 저장된 `panoId` 우선 초기화 구현
- [ ] invalid ID → 좌표 fallback 구현
- [ ] 기존 지도/로드뷰 탭과 오류 상태 회귀 테스트
- [ ] 모바일/데스크톱 대표 상세 페이지에서 시각 검증

## 테스트 계획

### 수집기 단위 테스트

- `pano_status = OK`에서 `panoId`, 좌표, 촬영일을 올바르게 추출
- 로드뷰 없음 상태가 `unavailable`로 저장
- SDK timeout/인증 실패가 `error`로 저장
- 거리 계산의 known coordinate fixture 검증
- SQL escaping과 batch flush 재개 동작 검증
- `dry-run`에서 UPDATE가 발생하지 않음

### 상세 페이지 테스트

- 저장된 `panoId`가 있으면 `position`보다 우선 사용
- 저장된 ID가 없으면 기존 좌표 fallback
- 저장된 ID가 실패하면 좌표 fallback
- `needs_review`도 사용자 화면에서는 정상 로드뷰 경로를 사용할 수 있음
- 로드뷰 실패가 지도 탭을 차단하지 않음

### 운영 검증

- 전수 수집 전/후 대상 수 일치
- `available` 결과의 `panoId` 비어 있지 않음
- `roadview_lat/lng`가 함께 존재
- 비정상적으로 먼 결과 상위 목록 검토
- 동일 `panoId`가 여러 주차장에 매핑된 결과를 별도 확인
- 배치 중단 후 재실행해 중복 반영이나 상태 손상이 없음

## 리스크와 대응

| 리스크 | 대응 |
|---|---|
| 수만 건 브라우저 호출로 인한 시간·쿼터 증가 | 동시성 제한, stage 실행, 진행률 저장, 필요 시 재수집 간격 적용 |
| 주차장 중심점이 입구와 다름 | 실제 파노라마 좌표와 거리 저장, 먼 결과 `needs_review`, 입구 좌표 개선은 별도 데이터 작업 |
| panoId가 더 이상 유효하지 않음 | 상세 페이지에서 실패 시 좌표 fallback, `roadview_checked_at` 기반 재검증 |
| 로드뷰가 없는 주차장 반복 조회 | `unavailable` 상태 저장 및 재시도 주기 분리 |
| SDK/인증 오류가 데이터 오류로 저장됨 | `error`와 `unavailable`을 분리하고 오류 메시지는 배치 로그에 보존 |
| 원격 D1 대량 UPDATE 중 실패 | 결과 파일 보존, 작은 flush 단위, 적용 전 remote export/백업 확인 |
| 네이버 API 사용 제한 또는 약관 이슈 | 전수 실행 전에 공식 사용량·저장 정책 확인 및 소규모 quota smoke test 수행 |

## 범위 제외

- 주차장 입구 좌표를 자동으로 새로 산출하는 기능
- 여러 방향/여러 시점의 panoId를 모두 저장하는 기능
- 로드뷰 이미지 자체를 다운로드하거나 자체 호스팅하는 기능
- 자동으로 `needs_review` 결과를 주차장 좌표까지 변경하는 기능
- 관리자 수동 검수 UI의 본격적인 큐레이션 기능

## 완료 조건

- [ ] 모든 주차장에 대해 수집 시도 결과가 `available`, `unavailable`, `needs_review`, `error` 중 하나로 기록된다.
- [ ] `available` row는 `roadview_pano_id`, 실제 파노라마 좌표, 거리, 확인 시각을 가진다.
- [ ] 전수 수집을 중단 후 재개할 수 있다.
- [ ] 상세 페이지가 저장된 `panoId`를 우선 사용하고 실패 시 좌표 fallback을 수행한다.
- [ ] 이마트 월계점 등 대표 사례의 파노라마 위치를 확인할 수 있다.
- [ ] 전수 수집 결과 리포트와 재시도 대상 목록이 보존된다.
- [ ] 테스트, lint, production build가 통과한다.

## 관련 문서

- [Issue #163 실행 계획: 상세 헤더 지도와 로드뷰 UX](./issue-163-roadview-map-ui.md)
- [Naver Maps API Panorama class](https://navermaps.github.io/maps.js.ncp/docs/naver.maps.Panorama.html)
- [Naver Maps API panorama module](https://navermaps.github.io/maps.js.ncp/docs/module-panorama.html)
