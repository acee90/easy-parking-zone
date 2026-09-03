# #166 목적지 페이지 구현 계획

- **작성일**: 2026-09-03
- **기획 문서**: [issue-166-destination-pages.md](./issue-166-destination-pages.md) (12장까지), [검토](./issue-166-destination-pages.review.md)
- **이 문서의 역할**: 기획을 닫고 무엇을 어떤 순서로 만들지를 정합니다. 각 단계는 산출물과 확인 방법을 갖습니다.
- **수치 표기 규약**: 기획 문서와 같습니다. 실측하지 않은 값은 **미확인**이라고 적고, 이 문서는 발행 페이지 수를 미리 적지 않습니다.

---

## 0. 기획 문서와 달라지는 두 가지

이 계획의 축은 한 문장입니다. **빈 페이지를 먼저 만들어 두고 채우는 것이 아니라, 데이터가 채워진 목적지만 한 장씩 발행합니다.** 주차장 상세페이지가 31,994장 중 7,500장을 내용 없이 등재해 겪고 있는 문제를 반복하지 않기 위해서입니다. 이 원칙을 적용하면 기획 문서의 두 곳이 바뀝니다.

### 0-1. `noindex` 중간 상태를 없앱니다

기획 문서 5-2절은 목적지를 "존재하지 않음 / 렌더링하되 noindex / 색인 대상"의 세 상태로 나눴습니다. 이 계획에서는 **가운데 상태를 없앱니다.** 페이지는 있거나(발행) 없거나(404) 둘 중 하나입니다.

`noindex` 상태의 용도는 "사이트 안 검색에서 착지할 페이지"였습니다. 그런데 사이트 안의 목적지 검색은 카카오 로컬을 실시간으로 호출해서 지도를 옮기는 방식이고(#164), `/near` 페이지가 있어야 동작하는 것이 아닙니다. 소비자가 없는 상태이므로 만들지 않습니다.

따라서 7-1절의 `index_state` 컬럼도 없습니다. `destinations`에 행이 있다는 것 자체가 게이트를 통과했다는 뜻입니다. 대신 `published_at`을 둡니다.

### 0-2. 1단계의 원천은 `poi_tags`가 아니라 지하철역입니다

기획 문서는 Tier 0을 `poi_tags` 219개로 잡았습니다. 그런데 그 219개의 좌표는 전부 카카오 유래라 승계할 수 없고(기획 2-3절), 공공데이터에 없는 이름이 100여 개라 저장이 허용되는 지오코더가 확인되기 전에는 좌표를 얻을 방법이 없습니다(R-9).

지하철역은 공공데이터에 좌표가 있고, 네이버 상위 페이지가 실제로 역 단위로 만들어져 있으며(12장), 이름의 표기 변형이 적습니다. **1단계는 지하철역만으로 진행합니다.** `poi_tags`는 지오코더 약관이 확인된 뒤 2단계로 미룹니다.

---

## 1. 파이프라인의 모양: 밀어 넣지 않고 끌어올립니다

```
후보 목록 (역 CSV)
   │
   ▼
evaluate-candidates.ts          ← 메모리에서 반경 계산 + 게이트 판정
   │                                통과분만 SQL로, 탈락분은 사유와 함께 JSON으로
   ├──▶ data/near/publish-YYYYMMDD.sql   (통과: destinations + destination_lots + aliases)
   └──▶ data/near/rejected-YYYYMMDD.json (탈락: 후보, 실패한 조건, 측정값)
   │
   ▼
사람이 rejected.json과 통과 건수를 보고 판단
   │
   ▼
wrangler d1 execute --remote --file=publish-YYYYMMDD.sql
   │
   ▼
/near/{slug} 응답 시작, sitemap-near.xml에 등재
```

세 가지 규칙이 있습니다.

1. **게이트를 통과하기 전에는 어떤 행도 만들지 않습니다.** 평가 스크립트가 `destinations`에 INSERT하는 유일한 경로이며, 통과분만 SQL로 냅니다.
2. **크론에 넣지 않습니다.** 1회성 배치이고, 다시 실행해도 안전해야 합니다. `destinations.id`는 `INSERT OR IGNORE`, `destination_lots`는 해당 목적지의 행을 `DELETE` 한 뒤 다시 넣습니다.
3. **SQL 적용 전에 중간 파일로 확인합니다.** dry-run 플래그 대신 `publish-*.sql`과 `rejected-*.json`이 그 역할을 합니다. 통과 건수와 탈락 사유 상위 5개를 보고 나서 적용합니다. 대량 적용은 SQL 파일을 `wrangler --file`로 한 번에 넣습니다. 행 단위로 wrangler를 호출하지 않습니다.

---

## 2. 단계별 계획

### 0단계: 코드가 아닌 선행 작업 (사람이 합니다)

| 작업 | 왜 먼저인가 | 완료 조건 |
|---|---|---|
| **네이버 서치어드바이저 등록 확인** | 이 프로젝트의 성공 판정 지표(4장)가 전부 서치어드바이저에서 나옵니다 | **완료(사용자 확인, 2026-09-03)**: 이미 등록되어 있고 `/wiki/` 페이지가 정상 수집되고 있었습니다. 검토 문서가 "미확인"이라 적은 것은 DNS TXT·검증 파일·meta 세 경로에 흔적이 없어서였고, 등록 방식이 달랐을 뿐입니다. 남은 일은 배포 후 `sitemap-near.xml`(262건)이 수집·색인되는지 보는 것입니다 |
| **지하철역 데이터셋 선정** | **선정 완료(2026-09-03): 전국도시철도역사정보표준데이터 (공공데이터포털 15013205).** 1,073행, 컬럼은 역번호·역사명·노선번호·노선명·환승역구분·역위도·역경도·운영기관명·역사도로명주소. 좌표는 위경도(WGS84)입니다. **XLSX만 제공되고 다운로드는 레일포털(data.kric.go.kr) 로그인 페이지라 스크립트로 받지 못했습니다.** 사람이 내려받아 CSV(UTF-8)로 저장해 `data/near/stations.csv`에 두면 `scripts/near/import-stations.ts`가 읽습니다. 환승역은 노선별 행이므로 스크립트가 200m 안 동명 역을 하나로 합칩니다 | `data/near/stations.csv` 존재. `import-stations.ts` 실행 결과 후보 수가 기록됨. **2026-09-03 대체 원천으로 진행**: OpenStreetMap Overpass(ODbL, 로그인 불필요)에서 `railway=station` + `subway`/`light_rail` 노드 837개를 받아 `import-stations-osm.ts`로 후보 785개를 만들었습니다. 화면은 `source`가 `osm:`이면 "© OpenStreetMap contributors"를 표기합니다. 표준데이터 CSV가 확보되면 갈아탑니다 |
| **10개 기준 검색어 확정** | 순위 변화를 잴 대조군입니다 | **완료(2026-09-03)**: [issue-166-rank-baseline.md](./issue-166-rank-baseline.md). 10개 중 5개에서 `/wiki/` 페이지로 6~9위, 5개는 없음, 1~5위 0개 |

**이 세 가지가 끝나기 전에는 1단계 코드에 착수하지 않습니다.** 특히 첫 번째가 그렇습니다.

### 1단계: 지하철역으로 첫 발행

의존 순서대로 적습니다. 각 항목은 이전 항목이 끝나야 시작할 수 있습니다.

**1-1. 마이그레이션 `migrations/0055_destinations.sql`**

기획 7장의 세 테이블에서 `index_state`를 빼고 `published_at`을 더한 것입니다.

```sql
CREATE TABLE destinations (
  id            TEXT PRIMARY KEY,              -- 'D-0001' 형식. 평가 스크립트가 발급
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  category      TEXT NOT NULL,                 -- 1단계는 'station'만
  lat           REAL NOT NULL,
  lng           REAL NOT NULL,
  address       TEXT,
  source        TEXT NOT NULL,                 -- 'public_data:<데이터셋 id>'
  source_id     TEXT,
  cluster_id    TEXT,
  lot_count     INTEGER NOT NULL,              -- 발행 시점 반경 내 주차장 수 (title에 씁니다)
  free_count    INTEGER NOT NULL DEFAULT 0,
  published_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_destinations_geo ON destinations(lat, lng);

CREATE TABLE destination_aliases (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  destination_id TEXT NOT NULL REFERENCES destinations(id),
  alias          TEXT NOT NULL,
  kind           TEXT NOT NULL,                -- spacing | line | search_term
  UNIQUE(destination_id, alias)
);

CREATE TABLE destination_lots (
  destination_id TEXT NOT NULL REFERENCES destinations(id),
  parking_lot_id TEXT NOT NULL REFERENCES parking_lots(id),
  distance_m     INTEGER NOT NULL,
  walk_minutes   INTEGER NOT NULL,
  evidence       TEXT,                         -- 'web_source:<id>' | NULL
  rank           INTEGER NOT NULL,
  PRIMARY KEY (destination_id, parking_lot_id)
);
CREATE INDEX idx_destination_lots_lot ON destination_lots(parking_lot_id);  -- 역방향 조회용
```

`idx_destination_lots_lot`은 주차장 상세페이지에서 "이 주차장으로 갈 수 있는 곳"을 뽑을 때 씁니다.

**1-2. Drizzle 스키마와 변환 함수**

- `src/db/schema.ts`에 세 테이블을 추가합니다.
- `src/server/transforms.ts`에 `rowToDestination`, `rowToDestinationLot`을 추가하고, 기존 63개 테스트와 같은 방식으로 테스트를 붙입니다.
- `src/lib/slug.ts`의 `parseIdFromSlug`에 `D-\d+` 패턴을 추가합니다. 테스트에 "석촌역-D-0001" 케이스를 넣습니다.

**1-3. 평가 스크립트 `scripts/near/`**

| 파일 | 하는 일 |
|---|---|
| `import-stations.ts` | 0단계에서 선정한 CSV를 읽어 `data/near/candidates.json`으로 정규화합니다. 환승역은 이름으로 합쳐 노선 목록을 `lines` 배열에 담습니다 |
| `evaluate-candidates.ts` | 후보마다 로컬 D1에서 반경 1km bbox로 주차장을 뽑아 거리를 계산하고, 게이트를 적용하고, 50m greedy 클러스터링을 하고, 통과분을 SQL로, 탈락분을 JSON으로 냅니다 |
| `lib/gate.ts` | 게이트 판정을 **순수 함수**로 둡니다. 입력은 후보와 주차장 배열, 출력은 `{pass: boolean, reason?: string, lots: ...}`. 테스트 대상입니다 |
| `lib/cluster.ts` | 50m greedy 클러스터링도 순수 함수로 둡니다. 테스트 대상입니다 |

게이트는 기획 5-3절 그대로입니다. 좌표 있음, 반경 1km 내 3곳 이상, 그중 2곳 이상이 요금 또는 면수 보유, 클러스터 대표. 네 번째 조건(목적지↔주차장 고유 근거)은 1단계에서 **web_source 제목이나 본문에 역 이름이 들어간 행이 1건 이상**으로 판정합니다.

쌍둥이 주차장 처리를 여기에 넣습니다. `KA-`와 공공데이터 id로 같은 주차장이 두 번 잡히는 경우(기획 R-1의 석촌역 사례)를 `(round(lat,4), round(lng,4), total_spaces)`로 묶어 한 쪽만 남기고, 충돌 목록을 `rejected` 옆의 `twins-YYYYMMDD.json`에 기록합니다. mustarddata가 잠실역을 두 번 등재한 오류를 우리는 만들지 않습니다.

**1-4. 서버 함수 `src/server/destinations.ts`**

| 함수 | 용도 |
|---|---|
| `fetchDestination({ slug })` | 페이지 loader. 없으면 `null`, 라우트에서 `notFound()` |
| `fetchDestinationLots({ destinationId })` | 비교표. `destination_lots` JOIN `parking_lots` JOIN `parking_lot_stats`, `rank` 순 |
| `fetchDestinationSnippets({ destinationId })` | 실제 후기 인용. `destination_lots.evidence`의 web_source 중 `relevance_score >= 40 AND filter_passed_v2 = 1`, 최대 3건 |
| `fetchDestinationsForLot({ parkingLotId })` | 주차장 상세페이지의 새 블록. `idx_destination_lots_lot`을 탑니다 |

`db.run()`은 쓰지 않고 `db.all()`을 씁니다(로컬 miniflare에서 rows가 비는 문제).

**1-5. 라우트 `src/routes/near/$slug.tsx`**

`wiki/$slug.tsx`의 loader 구조를 따릅니다. `head`는 다음을 냅니다.

- `<title>`: `{역명} 근처 주차장 {N}곳 · 무료 {M}곳 · 초보 추천 {K}곳 | 쉬운주차장`. M이나 K가 0이면 그 조각을 뺍니다.
- `robots`: `index, follow`. 행이 있으면 발행이므로 분기가 없습니다.
- `canonical`: 자기 자신.
- JSON-LD: `Place` + `ItemList`. `AggregateRating`은 내보내지 않습니다.

**1-6. 컴포넌트 `src/components/near/`**

기획 12-6절의 구성을 그대로 컴포넌트로 나눕니다.

| 컴포넌트 | 내용 | 재사용 |
|---|---|---|
| `DestinationHero` | H1 + 수치 타일(전체·무료·가장 가까운 곳·초보 추천). 값이 없는 타일은 그리지 않습니다 | 없음 |
| `EasiestPicks` | 난이도 순 상위 1~3곳. `reliability='none'` 제외. 각 항목에 후기 한 줄 | `getDifficultyIcon` |
| `DestinationLotList` | 정렬 탭(가까운 순 / 싼 순 / 쉬운 순 / 무료만). 모바일은 카드, 데스크톱은 테이블. 표 아래 "요금 정보가 없는 K곳은 제외했습니다" | `RelatedParkingLotsSection`의 `PricingCell`, `HourFee`를 **export해서 가져다 씁니다.** 복사하지 않습니다 |
| `DestinationMap` | 목적지 핀 + 주차장 핀. "지도에서 보기" → `/?near={id}` | `WikiMiniMap` |
| `DestinationSnippets` | 실제 후기 최대 3건, 출처 링크 | `WebSourceListSection`의 props가 맞으면 그대로, 아니면 얇은 래퍼 |
| `DestinationFaq` | 데이터 계산값으로만 답하는 문항. 무료 주차장 수, 가장 가까운 곳 거리, 초보 추천. 상세페이지 FAQ와 문장이 겹치지 않게 별도 문구 | `faq-generator.ts` 패턴 |

**1-7. 주차장 상세페이지의 새 블록**

`src/components/wiki/DestinationsForLotSection.tsx`를 만들고 `wiki/$slug.index.tsx`의 loader에 `fetchDestinationsForLot`을 추가합니다. `NearbyPlacesSection`은 손대지 않습니다. 결과가 0건이면 렌더링하지 않습니다.

**1-8. 사이트맵 `/sitemap-near.xml`**

`sitemap-handler.ts`에 `sitemapNear(db)`를 추가하고 `sitemapIndex`에 등록합니다. 단일 파일이고 5,000건을 넘을 때까지 분할하지 않습니다. 쿼리는 `SELECT slug, updated_at FROM destinations`뿐이어야 합니다. `sitemap-index.xml`의 콜드 응답 지연(#161)이 이 쿼리 때문에 더 나빠지면 안 됩니다. `/near` URL을 `sitemap-N.xml`에 섞지 않습니다.

**1-9. 지도 딥링크 `/?near={id}`**

`src/routes/index.tsx`가 `near` 검색 파라미터를 읽어 `fetchDestination`으로 좌표를 받고 지도를 그 위치로 엽니다. 목적지 페이지의 "지도에서 보기"가 갈 곳이므로 1단계에 포함합니다. 파라미터가 없거나 목적지가 없으면 지금과 같이 동작합니다.

### 1단계 확인 방법

정확도가 재현율보다 먼저입니다. 다음이 전부 통과해야 SQL을 적용합니다.

| 확인 | 방법 | 통과 기준 |
|---|---|---|
| 단위 테스트 | `bun --bun run test` | `gate.ts`, `cluster.ts`, `transforms` 추가분, `parseIdFromSlug` D- 케이스가 전부 통과 |
| 게이트 보정 | 역 후보 전체에 `evaluate-candidates.ts` 실행, **SQL 적용 전** `rejected-*.json` 검토 | 통과 건수와 탈락 사유 상위 5개를 이 문서 6장에 기록. 탈락 사유가 데이터 결손이 아니라 게이트 오류로 보이면 게이트를 고치고 다시 돌립니다 |
| 쌍둥이 | `twins-*.json` 검토 | 같은 주차장이 두 번 들어간 목적지가 0건 |
| SSR | `curl -A Googlebot` 으로 `/near/석촌역-D-…` 1건 | H1, `<title>`, canonical, JSON-LD 2블록, 주차장 목록이 HTML에 그대로 있음 (GSC 기준선 4장의 표와 같은 항목) |
| 모바일 | 375px 폭에서 `DestinationLotList` 스크린샷 1장 | 가로 스크롤 없음 |
| 역방향 링크 | 발행된 목적지에 속한 주차장 상세페이지 1건 | "이 주차장으로 갈 수 있는 곳" 블록에 해당 역 링크가 보임 |
| 사이트맵 | `curl /sitemap-near.xml`, `curl /sitemap-index.xml` | 발행 건수와 `<loc>` 수가 같고, index에 near가 등재 |

### 2단계: 판정과 확장 (1단계 배포 후 6주에서 8주 사이)

판정 입력은 기획 9-3절의 네 가지입니다. 서치어드바이저의 `sitemap-near` 수집·색인, GA4 `/near/` 랜딩 세션, GA4 `/wiki/` 랜딩 세션의 비하락, 10개 기준 검색어의 수동 순위(기준선 0/10).

통과했을 때만 다음을 순서대로 엽니다.

1. **`poi_tags` 219개 (기획의 Tier 0)**: 저장이 허용되는 지오코더(VWorld 또는 행안부 도로명주소)의 약관을 확인한 뒤에만. 같은 평가 스크립트에 후보 원천만 추가합니다.
2. **블로그 제목 마이닝 5,534행 (Tier 2)**: 서치어드바이저 유입 검색어로 수요 순 정렬. 좌표는 1번과 같은 조건.
3. **전통시장·대규모점포·관광지 (Tier 1 나머지)**: 데이터셋별 좌표계 확인 후.
4. **서울시 실시간 잔여 대수**: [#168](https://github.com/acee90/easy-parking-zone/issues/168). 공공 API라 약관 문제가 없고, 네이버 1위 페이지가 가진 유일한 우리 결손입니다.

통과하지 못했으면 원인을 기록하고 여기서 멈춥니다. 발행 건수를 늘리는 것으로 대응하지 않습니다.

---

## 3. 만들지 않는 것

| 만들지 않는 것 | 이유 |
|---|---|
| 게이트 미통과 목적지의 페이지 | 이 계획의 축입니다 |
| `noindex` 상태 | 0-1절 |
| 크론 파이프라인 | 1회성 배치로 충분하고, 자동 발행은 빈 페이지를 만드는 경로가 됩니다 |
| 목적지 단위 AI 요약 | 1단계에서는 실제 후기 인용으로 대체합니다. 연결 소스 3건 이상인 목적지가 얼마나 되는지 1단계 결과를 보고 2단계에서 판단합니다 |
| 상단 메뉴의 "목적지" 항목 | 검색 엔진에서 도착하는 페이지이고, 사이트 안에서는 주차장 상세페이지의 블록으로 들어갑니다 |
| 카카오 결과의 저장 | 약관. 기획 2장 |

---

## 4. 성공 판정 지표

| 지표 | 도구 | 기준선 (2026-09-03) | 2단계 판정 기준 |
|---|---|---|---|
| `sitemap-near` 수집·색인률 | 네이버 서치어드바이저 | 없음 (미발행) | 60% 이상 |
| `/near/` 랜딩 세션 | GA4 | 0 | 0이 아님, "○○ 근처 주차장" 검색어가 유입 리포트에 보임 |
| `/wiki/` 랜딩 세션 (월) | GA4 | 68,529 (2026-08) | 하락 없음. 하락 시 즉시 되돌림 |
| 기준 검색어 10개 순위 | 수동 | 0/10 | 10위 안 진입 건수 기록. 목표치는 두지 않고 추이만 봅니다 |

---

## 5. 순서 요약

```
0단계  서치어드바이저 등록 ─▶ 역 데이터셋 선정 ─▶ 기준 검색어 10개
1단계  0055 마이그레이션 ─▶ 스키마·변환 ─▶ 평가 스크립트 ─▶ 서버 함수
       ─▶ /near 라우트·컴포넌트 ─▶ 상세페이지 블록 ─▶ sitemap-near ─▶ 지도 딥링크
       ─▶ [확인 7항목] ─▶ SQL 적용 ─▶ 배포
2단계  6~8주 후 판정 ─▶ (통과 시) poi_tags ─▶ 블로그 마이닝 ─▶ 나머지 Tier 1 ─▶ 실시간 잔여
```

작업은 feature 브랜치에서 하고 PR로 올립니다. worktree는 쓰지 않습니다. 1단계는 PR 하나로 묶기에 크므로, "마이그레이션+스키마+스크립트", "서버 함수+라우트+컴포넌트", "상세페이지 블록+sitemap+딥링크" 세 PR로 나눕니다.

---

## 7. 목적지 목록 페이지(`/near`)는 데이터가 찰 때까지 미룹니다 (2026-09-03 판단)

두 형태를 검토했습니다. A는 지역 → 역 카드에 "주차장 N곳 · 무료 M곳 · 초보 추천 K곳"을 싣는 것, B는 "무료 3곳 이상인 역", "초보 추천이 있는 역" 같은 계산된 묶음을 위에 얹는 것입니다. 만들기 전에 remote 데이터로 각 칸이 실제로 채워지는지 셌습니다. 분모는 발행 목적지 257곳입니다.

| 칸 | 채워지는 목적지 | 판정 |
|---|---:|---|
| 주차장 N곳, 지역 | 257 (100%) | 채워짐. 다만 이것만으로는 "이름과 숫자 표"라 한 줄 나열과 다르지 않음 |
| 무료 1곳 이상 / 3곳 이상 | 230 / 159 | 채워짐 (B의 "무료 3곳 이상" 묶음 성립) |
| 역 100m 안 주차장 | 117 | 채워짐 (B 묶음 성립) |
| **초보 추천 (실제 신호 `estimated`·`confirmed` 기준)** | **56 (22%)** / 3곳 이상은 2 | **부족.** 이게 A 카드와 B "초보 추천 있는 역" 묶음의 핵심 칸인데 다섯에 넷이 비어 있음 |
| 후기·웹 글 3건 이상 | 43 | 부족 |

핵심 원인은 난이도 점수의 신뢰도 분포입니다. 발행 목적지에 걸린 주차장 5,308곳 중 `structural`(주차장 유형·규모로 만든 사전값) 65%, `none` 26%, `reference` 7%, `estimated` 1.2%, `confirmed` 0.2%입니다. 사전값을 "초보 추천"으로 부르면 목록 페이지가 통째로 추정치 위에 서게 됩니다.

**결정: 목록 페이지는 만들지 않고 미룹니다.** 사이트 안 진입로는 검색창 자동완성(PR #170)과 위키 상세페이지 블록으로 충분합니다.

**다시 꺼내는 조건**: `estimated`·`confirmed` 점수를 가진 주차장이 1곳 이상인 목적지가 **150곳(약 60%)** 을 넘을 때. 이 수치는 아래 쿼리로 잽니다. 그때 형태는 A를 기본으로 B의 "무료 3곳 이상"·"초보 추천 있음" 두 묶음을 위에 얹는 것으로 합니다. 서버 함수 `fetchDestinationIndex`는 이미 있습니다.

```bash
npx wrangler d1 execute parking-db --remote --command "
SELECT SUM(EXISTS(SELECT 1 FROM destination_lots dl JOIN parking_lot_stats s ON s.parking_lot_id=dl.parking_lot_id
  WHERE dl.destination_id=d.id AND s.reliability IN ('estimated','confirmed'))) real1, COUNT(*) total FROM destinations d"
```

같은 판단을 **목적지 페이지 자체에도 적용했습니다.** "초보 운전자에게 쉬운 곳" 섹션이 `structural` 점수까지 추천 근거로 쓰고 있었는데, 실제 신호(`estimated`·`confirmed`)가 있는 주차장만 쓰도록 좁혔습니다. 그 결과 이 섹션은 257곳 중 56곳에서만 그려지고, 나머지는 비교표부터 시작합니다. 8.3절 "없는 값은 만들지 않는다"의 적용입니다.

## 6. 실행 기록 (비어 있음)

1단계 게이트 보정 결과를 여기에 적습니다.

| 날짜 | 후보 수 | 통과 | 탈락 사유 상위 5 | 적용 여부 |
|---|---:|---:|---|---|
| 2026-09-03 (스모크) | 3 (손으로 만든 석촌역·잠실역·가짜역) | 2 | too_few_lots 1 (가짜역, 반경 내 0곳) | **로컬 D1에만 적용.** remote 미적용. 실제 데이터셋이 아니므로 발행 기록이 아니라 파이프라인 동작 확인용입니다 |
| 2026-09-03 (OSM 785건, 로컬 D1 스냅샷 기준) | 785 | **262** | no_evidence 469 · too_few_lots 53 · too_few_lots_with_data 1 | **remote D1 적용 완료 (2026-09-03, 사용자 승인).** 1차 262곳 → 라이브에서 석촌역 페이지에 324면 쌍둥이(62m)가 둘 다 실린 것을 보고 쌍둥이 기준을 60m→100m 로 넓혀 재평가·재적용: **destinations 257 · destination_lots 5,308 · 쌍둥이 319쌍 제거 · 발행 취소 5(동작·신용산·강남구청·신둔도예촌·양재시민의숲, 쌍둥이 제거 후 3곳 미만)**. 발행 취소는 `--existing=remote` 로 remote 발행 상태를 읽어 판정한다. lot_count 분포: 15곳+ 156 · 8~14곳 72 · 5~7곳 27 · 3~4곳 7. 쌍둥이 150쌍 제거. 큰 역(강남·잠실·사당·수원·신촌·판교·부산·대전·반월당·석촌) 전부 통과, 서면역·건대입구역은 no_evidence 탈락 |

스모크에서 확인한 것: 석촌역 반경 1km 주차장 20곳(무료 3, 근거 web_source 2건), 잠실역 24곳(무료 3, 근거 7건). 같은 주차장이 KA-/NV- 로 두 번 잡히는 쌍("송파근린공원주차장" 324면, 12m 차이)이 4자리 좌표 비교를 빠져나가서 `dedupeTwins`를 "60m 이내 + 면수 동일"로 바꿨습니다.

### 1단계 확인 7항목 결과 (2026-09-03, 로컬 D1 스모크)

| 확인 | 결과 |
|---|---|
| 단위 테스트 | `npx vitest run` 기준 slug 6 · gate 13 · cluster 5 통과. (`bun --bun run test`는 기존 테스트까지 전부 깨지는 환경 문제가 있어 node 로 실행. 별건) |
| 게이트 보정 | 스모크 3건으로 동작만 확인. 실제 보정은 stations.csv 확보 후 |
| 쌍둥이 | dedupe 기준 수정 후 테스트 추가 |
| SSR | `/near/석촌역-D-0002` Googlebot UA: `<title>` "석촌역 근처 주차장 20곳 · 무료 3곳 · 초보 추천 3곳", H1, self-canonical, robots index, JSON-LD 4블록(TrainStation·ItemList 20건·Breadcrumb·WebSite), 섹션 5개, `/wiki/` 링크 38개 |
| 모바일 | 375px 카드 목록 렌더링 확인. 가로 스크롤 없음 |
| 역방향 링크 | `/wiki/석촌역-2구역-공영주차장-…` 에 "이 주차장으로 갈 수 있는 곳 → 석촌역 근처 주차장" 블록 확인 |
| 사이트맵 | `/sitemap-near.xml` 2건, `/sitemap-index.xml` 에 등재 확인 |
| 지도 딥링크 | `/?near=D-0002` 로 지도가 석촌역 위치에서 열림 |

없는 목적지(`/near/…-D-9999`)는 404입니다.
