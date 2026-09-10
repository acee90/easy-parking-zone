# 사이트 점검 후속 작업 계획 (2026-09-10)

2026-09-10 사이트 점검(실사이트 브라우저 확인 + 리모트 D1 실측 + 코드 추적) 결과를 작업 단위로 쪼갠 문서.
각 작업은 **feature 브랜치 1개 = PR 1개** 단위다. 순서는 체감 효과 ÷ 노력 기준이며, 의존 관계가 있는 것만 표시했다.

## 0. 점검 당시 실측값

| 항목 | 값 | 출처 |
|---|---|---|
| 주차장 총수 | 54,072 (KA 19,323 / 공공 17,551 / MODU 15,825 / NV 893 / HP 480) | remote D1 |
| web_source ≥1 주차장 | 10,899 (20%) | remote D1 |
| 유저 리뷰 있는 주차장 | 154 | parking_lot_stats.review_count>0 |
| 유기 리뷰(시드 제외) 월별 | 4월 7 → 5월 11 → 6월 17 → 7월 24 → 8월 30 | user_reviews (is_seed=0, source_type IS NULL) |
| 네이버 크롤 처리량 | 50곳/회 × 12회/일 = 600곳/일 → 전체 1회전 ≈ 53일 | naver-blogs.ts:27, wrangler.jsonc crons |
| RECRAWL_DAYS | 30 (회전 주기 53일과 모순) | naver-blogs.ts:30 |
| 네이버 API 쿼터 사용률 | ≈5% (1,200/25,000 콜/일) | 계산 |
| YouTube | 4곳/회 → 48곳/일, search.list 100유닛이 쿼터의 대부분 | youtube.ts |
| raw에 이미 있는 유튜브 URL | 1,734건 | web_sources_raw.source_url LIKE youtube |
| `[GHOST_POI]` raw | 0건 (종결 raw 삭제 정책이 먼저 지움) | web_sources_raw |
| 종합 요약 크론 | 6곳/회 × 24회 = 144곳/일 | lot-summary-batch.ts |
| 전체 포인트 응답 | 압축 1.8MB / 해제 11.3MB / 데스크톱 1.27s | performance API |
| 초기 목록 fetch | 같은 payload 2회 | network 로그 |
| 목록 클릭 → 목록 교체 지연 | 약 2~3초, 200개 → 84개로 교체됨 | 실측 |
| 첫 화면 목록 20행 중 출처 간 중복 | 4쌍 (이화여고앞 공영 ×2, 미근동 공영 ×2, 서대문KG타워 ×2, 바비엥 ×2) | 실측 |

### 0-1. crawl_queue 기준선 (2026-09-10, remote D1)

| crawler | total | due(도래) | never_crawled | due p0~p3 | due p4 |
|---|---|---|---|---|---|
| naver_blogs | 54,130 | 27,737 | 22,132 | 5,654 | 22,083 |
| ddg | 54,130 | 42,198 | 22,827 | 20,110 | 22,088 |
| youtube | 54,130 | 52,446 | 50,977 | 30,358 | 22,088 |
| brave_search | 54,130 | 54,130 | 54,130 | 32,042 | 22,088 |

reliability 분포: **(stats 행 없음) 22,025** / structural 21,702 / none 7,140 / reference 3,093 / estimated 107 / confirmed 5

### 0-2. 핵심 발견 — 크롤 우선순위 역전

`syncQueue` 의 priority 식(`crawl-queue.ts:72-74`)은
`CASE s.reliability WHEN 'none' THEN 0 ... WHEN 'estimated' THEN 3 ELSE 4 END` 이다.
`parking_lot_stats` 행이 **아예 없는 주차장은 LEFT JOIN 이 NULL** 이라 `ELSE 4`, 즉 **최하위 우선순위**로 떨어진다.
`confirmed`(5곳)도 같이 4로 떨어진다.

실측 결과 naver_blogs 큐의 priority 4 는 **22,088곳이고 그중 22,084곳(99.98%)이 web_sources 0건**이다.
즉 **데이터가 가장 없는 주차장이 큐의 맨 뒤에 있다.** 전체 주차장의 41%다.
(공공데이터 sync 신규 5,773건 + MODU 전국 확장분이 여기 해당한다.)

`selectFromQueue` 는 `ORDER BY priority, next_at` 이므로 priority 0~3 도래분이 남아 있는 한
priority 4 는 **한 건도 선택되지 않는다.** 그리고 정상 상태에서 그 도래분은 마르지 않는다:

| | naver_blogs |
|---|---|
| 처리 능력 | 50곳/회 × 12회/일 = **600곳/일** |
| p0~p3 재크롤 수요 (32,042곳 ÷ RECRAWL_DAYS 30) | **1,068곳/일** |
| 결과 | 수요 > 능력 → priority 4 의 22,083곳은 **영구 기아 상태** |

RECRAWL_DAYS 를 90으로 늘리면 수요가 356곳/일로 떨어져 능력(600) 안으로 들어온다.
여기에 우선순위 역전까지 고치면 22,083곳이 먼저 소진된다(600곳/일 → 약 37일).
**두 변경은 같이 나가야 한다.** 주기만 늘리면 22K는 여전히 뒤에 있고,
우선순위만 고치면 그 뒤에 재크롤 수요가 능력을 다시 넘는다.

### 결정 사항 (사용자 확인)

- **네이버 크롤 2배(전용 크론 슬롯)는 보류.** 상세/위키 페이지가 요약본 중심이라 raw 증가가 바로 체감되지 않는다. 체감의 게이트는 raw 양이 아니라 (1) 요약 생성 처리량 144곳/일, (2) 필터 pass율 10~25%, (3) **사용자가 실제로 보는 주차장**에 예산이 가느냐다. 그래서 처리량 확대 대신 **예산 재배분(A-1, A-2)** 으로 간다.
- RECRAWL_DAYS는 늘려서 모순을 없앤다 (A-1).
- 헤더 수치 "주차장 5.4만 · 리뷰 240 · 영상/포스팅 2.4만"은 **유지**. 사이트에 직접 남긴 별점과 블로그 글은 중요도가 다르므로 합치지 않는다.
- 목록 클릭 문제는 **B안(한 번 클릭으로 상세)** 으로 간다 (C-1).

---

## A. 크롤 예산 재배분 (데이터)

> **측정 도구**: `bun run scripts/audit-metrics.ts --remote` (A-1 에서 추가).
> A 작업의 모든 평가항목을 한 번에 찍어 `data/audit-metrics-YYYYMMDD.json` 으로 남긴다.
> 각 작업 반영 **전/후**로 한 번씩 돌려 아래 표의 「결과」 칸을 채운다.

### A-1. 재크롤 주기 연장 + 우선순위 역전 수정

- **목표**: 크롤 예산을 「이미 데이터 있는 곳의 갱신」에서 「아직 아무 데이터도 없는 22,084곳」으로 돌린다. 0-2 의 두 문제를 함께 고친다.
- **변경**
  - `src/server/crawlers/lib/crawl-queue.ts` PRIORITY 식: `parking_lot_stats` 행이 없으면 **0(최상위)**, 있으면 reliability 순. `confirmed` 도 등급에 넣는다.
    ```
    CASE
      WHEN s.parking_lot_id IS NULL THEN 0   -- 한 번도 스코어링 안 됨 = 근거 0건
      WHEN s.reliability = 'none'       THEN 1
      WHEN s.reliability = 'structural' THEN 2
      WHEN s.reliability = 'reference'  THEN 3
      WHEN s.reliability = 'estimated'  THEN 4
      WHEN s.reliability = 'confirmed'  THEN 5
      ELSE 3 END
    ```
    `ELSE` 를 최하위가 아니라 중간(3)으로 둔다 — 예상 못한 값이 다시 기아를 만들지 않게.
  - `RECRAWL_DAYS` 30 → **90**: `naver-blogs.ts:30`, `duckduckgo-search.ts:16`, `brave-search.ts:16`, `youtube.ts:22`. 상수는 `lib/crawl-queue.ts` 에 `RECRAWL_DAYS` 하나로 모으고 각 크롤러가 import.
  - `wrangler.jsonc` crons 주석: "selectPriorityLots 가 31,994행 스캔" 문단은 crawl_queue(0052) 도입 전 이야기라 사실이 아니다. 현재 사실로 교체하고 90일 정책 근거를 남긴다.
  - **적용 후 1회성 reprice**: 배포 후 `syncQueue` 가 하루 1회 돌며 고치지만, 즉시 반영하려면 같은 UPDATE 를 수동 1회 실행한다 (`scripts/reprice-crawl-queue.ts`, 코드와 동일한 식). SQL emit → `wrangler --file` 일괄.
- **부작용 점검**
  - priority 0 이 22,025곳으로 커지면 같은 priority 안에서는 `next_at` 오름차순이므로 `2000-01-01` 인 never_crawled 가 먼저다. 의도한 순서다.
  - **고아 큐 행 58개**: `crawl_queue` 54,130행 > `parking_lots` 54,072행. 삭제된 주차장을 가리키는 행이다. 스칼라 서브쿼리가 NULL 을 돌려주면 priority 가 NULL 이 되고 SQLite 는 `ORDER BY` 에서 NULL 을 맨 앞에 놓는다 — 없는 주차장이 큐 선두를 차지한다. reprice 스크립트는 `EXISTS` 가드로 건드리지 않는다. (기존 `syncQueue` 는 `<>` 비교가 NULL 이라 우연히 안전했다.)
  - 예상 분포: p0 22,025 / p1 7,140(none) / p2 21,702(structural) / p3 3,093(reference) / p4 107(estimated) / p5 5(confirmed) / 미변경 58(고아)

#### A-1 평가항목

| # | 지표 | 측정 | 기준선 (09-10) | 기대값 | 시점 | 결과 |
|---|---|---|---|---|---|---|
| 1 | naver_blogs priority 0 주차장 수 | `SELECT COUNT(*) FROM crawl_queue WHERE crawler='naver_blogs' AND priority=0` | 7,140 | **≥ 22,000** (stats 없는 22,025 가 0으로 올라옴) | reprice 직후 | **22,025 ✅** |
| 2 | priority 4 잔량 | 같은 표 priority=4 | 22,088 | **≤ 200** (estimated 107 + confirmed 5 는 4~5로 이동) | reprice 직후 | **165 ✅** (107 estimated + 58 고아) |
| 3 | 다음 600곳(하루치 선정) 중 web_sources 0건 비율 | `selectFromQueue` 와 같은 WHERE·ORDER BY 로 LIMIT 600 | **67.7%** (406/600) | **≥ 95%** | reprice 직후 | **100.0%** (600/600) ✅ |
| 4 | RECRAWL_DAYS 코드값 | grep | 30 ×4 | 90, 단일 상수 | PR 머지 | **90, `crawl-queue.ts` 단일 ✅** |
| 5 | web_sources 0건 주차장 수 | `SELECT COUNT(*) FROM parking_lots p LEFT JOIN (SELECT DISTINCT parking_lot_id id FROM web_sources) w ON w.id=p.id WHERE w.id IS NULL` | **43,172** | **1주 뒤 −3,000 이상** (600곳/일 × 7일 중 매칭 성공분) | +7일 | 대기 (09-17) |
| 6 | 크롤 처리량 (선정 수) | `pipeline_daily_stats` 크롤 대상 선정 수 | 현행 | **변동 없음** (±10%). 줄면 큐 조회가 깨진 것 | +1일 | 대기 (09-11) |
| 7 | D1 rows_read | wrangler 실행 meta / CF 대시보드 | 현행 | **증가 없음** (같은 인덱스 조회) | +1일 | 대기 (09-11) |

- **판정**: 1~4 가 전부 통과해야 A-1 완료. 5~7 은 관측 항목이며 6·7 이 어긋나면 롤백.
- **결과 (2026-09-10 적용)**: **1~4 전부 통과.** PR #198 머지 → `bun run deploy` → `reprice-crawl-queue.ts --remote --apply` (216,289행 갱신, 2.1초). 적용 후 분포는 **p0 22,025 / p1 7,140 / p2 21,701 / p3 3,094 / p4 165 / p5 5** 로 예상과 일치했다. p4 의 165 는 estimated 107 + 고아 58 이며, 고아가 남은 것은 `EXISTS` 가드가 의도대로 동작한 결과다.
- **의존**: 없음. A-2 는 이 위에 올라간다.

### A-2. 크롤 우선순위에 트래픽 반영

- **목표**: 첫 화면(서울 도심)이 "데이터 없음" 일색인 문제. crawl_queue priority는 reliability 등급만 보고 PV를 모른다.
- **변경**
  - `migrations/0058_crawl_queue_pin.sql`: `crawl_queue.pinned_at TEXT` 추가.
  - `crawl-queue.ts` `syncQueue`: reprice UPDATE 에 `AND pinned_at IS NULL`. 사람이 고정한 우선순위를 하루 뒤에 되돌리지 않는다.
  - `scripts/pin-crawl-priority.ts`: GA4 CSV → 대상 선별 → SQL emit → `--apply`. `--unpin` 으로 전체 해제.
    - CSV 는 `lot_id` 열이나 경로 열(`page_path` 등) 중 아무거나 받는다. 경로면 `parseIdFromSlug` 로 id 를 뽑는다.
    - **이미 web_sources 가 있는 곳은 대상에서 뺀다** — 앞으로 당길 이유가 없다.
    - 고정 우선순위는 `-1`. priority 0(근거 0건)보다 앞서야 하기 때문이다.
- **설계 메모 — 왜 `priority_override` + `COALESCE` 가 아닌가**
  `ORDER BY COALESCE(priority_override, priority)` 는 `idx_crawl_queue_pick(crawler, priority, next_at)` 을 못 탄다.
  선정이 다시 크롤러당 54,130행 전체 스캔이 되어 **0052 가 없앤 비용이 그대로 돌아온다.**
  그래서 정렬 키는 `priority` 하나로 두고, 고정 여부만 별도 컬럼에 기록한다.
- **확인된 사실**: `syncQueue` 는 `priority <> (재계산값)` 인 행을 전부 덮어쓴다. 즉 **고정 표시 없이는 반드시 하루 만에 되돌아간다.** 코드로 확인했으므로 +1일 관측이 필요 없다.

#### A-2 평가항목

| # | 지표 | 측정 | 기준선 (09-10) | 기대값 | 시점 | 결과 |
|---|---|---|---|---|---|---|
| 1 | 고정 대상 lot 이 priority −1·next_at 도래 상태인가 | 입력 CSV의 lot_id 를 crawl_queue 와 조인 | 0% | **100%** | 스크립트 직후 | |
| 2 | syncQueue 1회 실행 후에도 고정이 유지되는가 | 다음날 `pinned_at IS NOT NULL AND priority=-1` 카운트 | — | **감소 0** | +1일 | |
| 3 | 대상 lot 중 web_sources ≥1 비율 | web_sources 조인 | 0% (PV 있는데 근거 0) | **≥ 60%** | +7일 | |
| 4 | 첫 화면(서울 중구 zoom 14) 목록 20행 중 "데이터 없음" | 브라우저 실측 | **11/20 = 55%** | **≤ 30%** | +14일 | |

- **판정**: 1·2 가 즉시 판정, 3·4 는 관측. 2가 실패하면 마이그레이션 추가 후 재적용.
- **의존**: A-1 (PRIORITY 식 정리 후).

### A-3. 유튜브 검증 백로그 소진 (원래 계획에서 방향 수정)

> **09-10 실측으로 전제가 바뀌었다.** 원래 계획은 "raw 에 있는 유튜브 URL 을 주워
> search.list(100유닛) 대신 videos.list(1유닛)로 메타를 채운다"였다.
> 그런데 그 1,742건은 **ddg/naver 가 주운 URL 이 아니라 유튜브 크롤러가 직접 넣은 것**이다
> (`source='youtube_video'` 100%). 이미 search.list 로 값을 치른 결과물이다.
>
> 진짜 문제는 따로 있다: **1,742건 전부 `matched_at IS NULL`, `filter_passed IS NULL`.**
> 하나도 주차장에 붙지 못했다. `ai-filter-batch.ts:41` 이 `source != 'youtube_video'` 로
> 유튜브를 크론 파이프라인에서 의도적으로 제외하고, 대신 수동 3단계
> (extract → subagent 검증 → apply)로 처리하게 되어 있는데 **그 수동 단계가 안 돌고 있었다.**
>
> 그래서 하루 9,600유닛을 써서 모은 결과가 `parking_media` 에 211건(78곳)만 남았다.

- **목표**: 이미 값을 치른 1,742건을 소진해 영상 콘텐츠로 만든다. **추가 쿼터 0.**
- **변경 / 실행**
  1. `scripts/extract-youtube-for-verify.ts --remote --limit=1800 --shards=18` — 97건 × 18 샤드
  2. `youtube-video-verifier` 기준으로 Haiku 서브에이전트 병렬 판정 → `*-verified.json`
     (프로젝트 에이전트가 세션에 안 뜨면 general-purpose + `model: haiku`, 판정 기준 인라인)
  3. `scripts/apply-youtube-verify.ts --remote --input-dir=data/youtube-verify`
     — 통과분은 `parking_media` INSERT, 탈락분은 `filter_passed=0` 으로 종결
  - ⚠️ `data/youtube-verify/` 에 **2026-05-27 자 `-verified.json` 이 남아 있었다.** 그대로 두면
    apply 가 옛 결과를 다시 적용한다. `archive-20260527/` 로 옮기고 시작할 것.
- **구조적 후속** (별도 PR)
  - 검증을 크론에 넣거나, 안 돌릴 거면 `youtube.ts` BATCH_SIZE 를 줄인다. 지금은 **소비되지 않는 데이터를 하루 9,600유닛으로 계속 사들이는 상태**다.
  - 발견 경로 보강: ddg/naver 쿼리에 `site:youtube.com` 변형 추가는 위 백로그를 다 쓴 뒤에.

#### A-3 평가항목

| # | 지표 | 측정 | 기준선 (09-10) | 기대값 | 시점 | 결과 |
|---|---|---|---|---|---|---|
| 1 | 검증 대기 raw | `source='youtube_video' AND filter_passed IS NULL` | **1,742** | **≤ 100** | apply 후 | |
| 2 | 통과율 | passed ÷ total | — | **15~50%** (에이전트 정의 기준). 벗어나면 판정 기준 재검토 후 재실행 | 검증 직후 | |
| 3 | `parking_media` 유튜브 건수 | COUNT | **211건 / 78곳** | **≥ 500건** | apply 후 | |
| 4 | 영상 있는 주차장 수 | `COUNT(DISTINCT parking_lot_id)` | **78곳** | **≥ 250곳** | apply 후 | |
| 5 | 추가 YouTube 쿼터 소모 | 콜 수 | — | **0** (이미 값을 치른 데이터) | apply 후 | |
| 6 | 통과분 표본 20건 사람 검수 | 수동 | — | 오탐 **≤ 1건** | apply 전 | |

- **판정**: 2와 6이 게이트다. 통과율이 범위를 벗어나거나 표본 오탐이 2건 이상이면 **apply 하지 않는다** (정확도 > 재현율).
- **의존**: 없음. 쿼터 증량 신청(무료)은 병행.

#### A-3 1차 시도 결과 (2026-09-10) — **적용 안 함**

12개 샤드(1,164건)를 Haiku 서브에이전트로 판정했고, 통과 245건이 나왔다(평균 21%, 범위 안).
그런데 **통과분 20건 표본 검수에서 오탐이 14건**이었다. 게이트(오탐 ≤1건)를 크게 벗어나
`data/youtube-verify/rejected-20260910/` 로 격리하고 **D1 에 반영하지 않았다.**

오탐 예시 (전부 `filter_passed=true` 로 판정된 것들):

| hint lot | 영상 제목 | 실제 |
|---|---|---|
| 원미구청 | 상동호수공원 풍경 | 다른 장소 |
| 잠원동 방음언덕형 | 미쉐린 빕 구르망 서울 10곳 | 전국 리스티클 |
| 삼정2호 | 부천신축아파트 … 분양시작 | 부동산 광고 |
| 다산(중동역) | 부천신축빌라 매매가 2억원대 | 부동산 광고 |
| 북구청인근 | 청솔빌라트 방2 반전세 8000/20 | 부동산 매물 |
| 응암3동 공영주차장 | 서부청기와감자탕 24시간영업 | 맛집 |

**원인 두 가지.**

1. **통과율 밴드를 프롬프트에 적은 것이 앵커가 됐다.** 샤드 01 은 처음에 1.0%(97건 중 70건이
   부동산 광고 — 판정이 옳았다)로 나왔는데, 에이전트가 "15~50% 범위"를 보고 **스스로 다시 돌려
   25.8% 로 올렸다.** 올라간 25건 대부분이 오탐이다. 품질 기준을 판정자에게 알려주면
   판정이 아니라 그 숫자를 맞추려 든다.
2. **"시설 방문 영상은 통과" 규칙이 공영/노상 주차장에 잘못 적용됐다.** 이 규칙은 백화점·마트처럼
   **주차장 = 시설**인 경우를 위한 것인데, "비둘기공원"·"응암3동 공영주차장" 같은 lot 에도
   근처 맛집 영상을 통과시키는 근거로 쓰였다.

**다음 시도에 고칠 것**
- 프롬프트에서 **통과율 언급을 뺀다.** 통과율은 사후 관측 지표로만 쓴다.
- 통과 조건을 좁힌다: `hint_lot_name` 또는 시설 고유명이 **title/description 에 문자 그대로 등장**해야 한다. 지역명만 일치하는 것은 통과 근거가 아니다.
- 시설 방문 통과는 **부설 주차장(백화점·마트·병원 등 시설 소유)에만** 적용한다.
- 판정 결과에 근거 문자열(어느 필드의 어느 표현이 일치했는지)을 같이 받아 기계적으로 재검증한다.

#### A-3 부수 성과 — 유튜브 크롤러 가드 (적용함)

검증 자체는 못 썼지만, 그 과정에서 **크롤러가 값을 못 건질 대상에 가장 비싼 쿼터를 쓰고 있다**는 걸 확인했다.

- 검증을 통과해 `parking_media` 에 남아 있는 영상 211건의 lot type 은 **노외 195 / 부설 16 / 노상 0**. 노상 5,316곳에서 나온 영상은 **한 건도 없다.**
- `isGenericName` 가드가 naver·ddg·brave 에는 있는데 **youtube 에만 빠져 있었다.**

→ `youtube.ts` 에 `isWorthSearching()` 추가: 노상 제외 + 일반명 제외. BATCH_SIZE 가 4뿐이라
걸러낸 만큼 한 사이클이 비지 않도록 6배로 넉넉히 뽑아 거르고, 걸러낸 lot 도 `next_at` 을 미뤄
다음 사이클에 같은 것들이 큐 앞을 막지 않게 했다.

### A-4. 출처 간 중복 병합

- **목표**: KA ↔ 공공 ↔ MODU ↔ NV 간 같은 주차장을 하나로. 리뷰·웹 글이 중복에 쪼개지는 희석 해소. 새 데이터 없이 곳당 신호가 늘어나는 유일한 레버.
- **변경**
  - `scripts/find-cross-source-dupes.ts`: 후보 규칙 = 거리 ≤ 60m **AND** (정규화 이름 일치 **OR** 주소 일치). 정규화 = 공백/괄호/"주차장"/"공영"/"민영" 제거. 출력은 `data/cross-source-dupes.json` (쌍 + 근거 + 판정 보류 플래그). **자동 병합 금지**, 정확도 우선.
  - 병합 규칙: 대표 lot = (유저 리뷰 있음 > 공공데이터 출처 > web_sources 많음). 흡수되는 lot의 `user_reviews`, `web_sources`, `parking_media`, `votes/bookmarks`, `lot_field_edits` 의 parking_lot_id를 대표로 UPDATE, 흡수 lot은 `merged_into` 컬럼(마이그레이션 1개)으로 남기고 목록/사이트맵/포인트에서 제외. 위키 슬러그는 301.
  - 적용은 SQL chunk emit + `wrangler --file` 일괄 (per-row wrangler 금지).
  - 병합 후 `score-recompute-queue` 에 대표 lot enqueue.

#### A-4 평가항목

| # | 지표 | 측정 | 기준선 (09-10) | 기대값 | 시점 | 결과 |
|---|---|---|---|---|---|---|
| 1 | 후보 쌍 수 / 자동확정 / 보류 | `data/cross-source-dupes.json` | 미측정 | 보류 비율 **≤ 30%**. 넘으면 규칙이 느슨함 | 스크립트 직후 | |
| 2 | 자동확정 표본 30쌍 사람 검수 정확도 | 수동 | — | **≥ 97%** (오탐 1건 이하). 미만이면 병합 중단 | 병합 전 | |
| 3 | 첫 화면(서울 중구 zoom 14) 20행 중 중복 쌍 | 브라우저 실측 | **4쌍** | **0쌍** | 병합 후 | |
| 4 | 병합 lot 의 web_sources·review 합산 | 표본 20건 전후 비교 | — | **손실 0건** (합계 보존) | 병합 후 | |
| 5 | parking_lots 노출 수 감소분 | 사이트맵 URL 수 | 현행 | **= 흡수 lot 수** (±0) | 병합 후 | |
| 6 | 병합 lot 의 final_score 재계산 | score-recompute 큐 소진 후 | — | **전건 재계산** | 병합 +1일 | |

- **판정**: 2가 게이트다. 97% 미만이면 병합 SQL 을 적용하지 않는다 (정확도 > 재현율).
- **의존**: 없음. 단, **MODU 내부 중복 보류 11쌍**(`project_modu_intra_dedup_2026_09`)과 같은 판정 기준을 쓴다.

### A-5. Ghost POI 보존

- **목표**: `[GHOST_POI]` 사유 raw가 삭제 정책에 먼저 지워져 채굴 불가(현재 0건). 삭제 전에 따로 남긴다.
- **변경**
  - 종결 raw 삭제 스테이지(`scheduled.ts` 의 terminal-raw purge)에서 `match_fail_reason LIKE '[GHOST_POI]%'` 행은 삭제 전 `ghost_poi_candidates`(lot_name_guess, region, source_url, seen_count, first_seen, last_seen) 테이블로 UPSERT. 마이그레이션 1개.
  - `scripts/ghost-poi-report.ts`: seen_count 내림차순 상위 N → 공공데이터/이름 검색으로 실제 lot 후보 제시. 등록은 사람 판단.

#### A-5 평가항목

| # | 지표 | 측정 | 기준선 (09-10) | 기대값 | 시점 | 결과 |
|---|---|---|---|---|---|---|
| 1 | `ghost_poi_candidates` 행 수 | COUNT | **0** (삭제 정책이 먼저 지움) | **≥ 100** | +14일 | |
| 2 | seen_count ≥ 2 후보 | COUNT | 0 | **≥ 20** | +14일 | |
| 3 | 상위 20건 중 실제 주차장 비율 | 수동 검수 | — | **≥ 50%**. 미만이면 추출 규칙 재검토 | +14일 | |
| 4 | 삭제 스테이지 처리 시간 | 크론 로그 | 현행 | **증가 ≤ 10%** | +1일 | |

- **의존**: 없음.

### A-6. UGC 훅 2개

- **목표**: 비용 거의 0인 리뷰 유도. 답은 아니고 훅이다(유기 리뷰는 트래픽 종속).
- **변경**
  - **재방문 프롬프트**: `NavigationButton.tsx` 길찾기 앱 실행 시 `localStorage.lastNav = {lotId, name, at}`. 다음 방문(`__root.tsx` 또는 `index.tsx` 마운트) 시 `at` 이 2시간~14일 사이면 하단 토스트 "지난번 ○○ 주차장 어땠나요?" + 별 5개 1탭 → `createReview`(overall만). 1회 노출 후 삭제.
  - **목록 인라인 별점**: `ParkingSidebar.tsx` / `MobileBottomPanel.tsx` 의 "데이터 없음" 행에서 배지 자리에 `StarRatingInput size="sm"`. 탭하면 즉시 등록(닉네임/코멘트 없음). D-1과 같은 PR로 묶어도 된다.

#### A-6 평가항목

| # | 지표 | 측정 | 기준선 (09-10) | 기대값 | 시점 | 결과 |
|---|---|---|---|---|---|---|
| 1 | 유기 리뷰 월간 건수 | `user_reviews` is_seed=0, source_type NULL | 8월 **30건** | **+50% (45건 이상)** | +30일 | |
| 2 | 재방문 프롬프트 노출→등록 전환율 | GA4 `review_prompt_rated` ÷ `review_prompt_shown` | — | **≥ 8%** | +14일 | |
| 3 | 목록 인라인 별점 등록 수 | GA4 `inline_rating_submitted` | 0 | **≥ 20건/주** | +14일 | |
| 4 | 스팸·저품질 유입 | 같은 ip_hash 다건, 코멘트 없는 극단 별점 비율 | 현행 | **비정상 급증 없음**. 있으면 rate limit 강화 | +14일 | |

- **판정**: 1이 본 지표, 2·3은 훅별 기여도. 4는 안전 장치.
- **의존**: D-1 (배지 제거)와 같은 자리.

---

## B. 서버 쿼리·응답

### B-1. 목록 쿼리 거리순 정렬

- **목표**: `fetchParkingLots` 가 ORDER BY 없이 LIMIT 200 → 넓은 줌에서 임의의 200개. "가장 가까운 2.4km" 인데 중심부는 빠짐.
- **변경**
  - `src/server/parking.ts:71-98`: 입력에 `centerLat/centerLng` 추가(없으면 bounds 중심). `ORDER BY (p.lat-:cLat)*(p.lat-:cLat) + (p.lng-:cLng)*(p.lng-:cLng)` 후 LIMIT. 인덱스는 못 타지만 bounds 필터가 먼저라 실측 확인.
  - `src/routes/index.tsx:129-149` `handleBoundsChanged` 에서 중심 좌표 전달.
- **검증**: 서울 전역 줌에서 목록 1번이 중심부 주차장인지. rows_read 전후(`--json` meta).
- **의존**: 없음. C-1 이전에 하면 클릭 후 목록 교체 폭도 줄어든다.

### B-2. 초기 목록 fetch 중복 제거

- **목표**: 마운트 시 같은 payload 2회(필터 effect + onInit emitBounds).
- **변경**: `src/routes/index.tsx:168-174` 필터 재조회 effect는 `filters` 변경에만 반응하도록 분리(첫 렌더 skip ref). 또는 `handleBoundsChanged` 안에서 `bounds+filters` 키로 in-flight 중복 제거.
- **검증**: 네트워크 로그 초기 로드 1회.
- **의존**: 없음. B-1과 같은 PR 가능.

### B-3. 전체 포인트 응답 경량화

- **목표**: 압축 1.8MB / 해제 11MB / 1.3s. 모바일 첫 화면.
- **변경**
  - 원인 확정 먼저: 응답 본문 앞 400자 확인(점검 때 본문 fetch가 빈 값이라 미확인). serverFn 직렬화(값마다 `{t,s}` 래핑)라면 예상대로.
  - `src/routes/api/points.ts`(Route API) 신설: `[[id, lat(소수 5자리), lng, score|null], ...]` 배열만. 이름은 뺀다(라벨은 zoom≥15에서 `fetchParkingLots` 결과로 이미 있음 — `MapView.tsx:356-379` 의 경량 마커 라벨 경로만 점으로 교체). 기존 Cache API 키/버전 로직(`parking.ts:115-128`) 그대로 이전. `Cache-Control: public, max-age=3600` + ETag.
  - `index.tsx:99-106` `fetchAllParkingPoints` → `fetch('/api/points')`. `useSuperCluster` 입력 형태 맞춤.
- **검증**: 해제 크기 ≤ 3MB, 전송 ≤ 600KB. 클러스터 집계(easy/hard/score)가 동일한지 스냅샷 테스트.
- **의존**: D-2 (무데이터 마커를 점으로) 와 같이 하면 이름 제거가 자연스럽다.

---

## C. 지도 상호작용

### C-1. 목록 한 번 클릭 → 상세 (B안)

- **목표**: 클릭 후 2~3초 뒤 목록 교체로 두 번째 클릭이 다른 주차장을 누르는 문제. 데스크톱 사이드바만 해당(모바일 패널은 선택 즉시 사라짐).
- **원인 체인**: `index.tsx:216 handleSidebarSelect` → `MapView.tsx:255-272 setZoom(16)+panTo` → `MapView.tsx:284-287` 800ms 디바운스 → `index.tsx:129-149` mapCenter 즉시 갱신 + fetch 대기 후 parkingLots 교체 → `ParkingSidebar.tsx:51-66` 재정렬 2회.
- **변경**
  - `index.tsx:216-226` `handleSidebarSelect`: 항상 `setSelectedLot(lot); setViewMode('detail')`. 같은 항목 재클릭 분기 제거.
  - `ParkingSidebar.tsx:119` aria-label "선택/상세보기" 분기 → "상세보기"로 통일. 선택 행의 "상세보기" 칩은 hover 상태에서만 보이도록 유지하거나 제거(둘 중 하나, 두 경로가 같은 일을 하므로).
  - 마커 클릭(`handleMarkerClick`, `index.tsx:178-187`)은 **지금대로** 첫 클릭 강조/재클릭 상세 유지. 지도에서는 미리보기 의미가 있다.
  - 상세에서 닫기 시 `handleCloseDetail` 이 selectedLot을 유지하므로 목록 복귀 후 강조는 그대로.
- **검증**: 목록 2번째 항목 클릭 → 즉시 상세. 브라우저에서 클릭 직후 3초 내 다른 항목을 눌러도 상세가 그 항목으로 바뀌는지.
- **의존**: 없음.

### C-2. 지도 이동 속도

- **목표**: moveTo 시 `setZoom(16)` 애니메이션 뒤에 `panTo` 가 따로 도는 2단계라 느리다. 여기에 800ms 디바운스가 더해진다.
- **변경**
  - `MapView.tsx:255-272`: `setZoom(16); panTo(adjusted)` → `mapRef.current.morph(adjusted, 16, { duration: 250, easing: 'easeOutCubic' })` 한 번. `naver.maps.Map#morph(coord, zoom, transitionOptions)` 의 `TransitionOptions {duration, easing}` 사용. 이미 zoom 16 이상이면 zoom은 현재값 유지(줌아웃 방지).
  - `MapView.tsx:399-409` 마커 클릭 panTo 도 같은 옵션.
  - `MapView.tsx:284-287` 디바운스: 애니메이션 중 800ms → **duration + 100ms** 로 연동. `animatingRef` 의 setTimeout 800도 같은 값.
  - `getPanToAdjusted` 의 패널 폭 보정은 그대로.
- **검증**: 클릭 → 이동 완료 → 목록 갱신까지 1초 이내. 애니메이션 중 bounds 이벤트가 fetch를 여러 번 쏘지 않는지(네트워크 1회).
- **의존**: C-1 과 같은 PR 권장.

---

## D. 목록·지도·상세 표시

### D-1. "데이터 없음" 배지 제거

- **변경**: `ParkingSidebar.tsx`, `MobileBottomPanel.tsx`, `ParkingCard.tsx` 에서 `getDifficultyLabel` 이 데이터 없음을 돌려주면 배지를 렌더하지 않는다. 그 자리는 A-6 인라인 별점 또는 비움. 요금/면수 칩은 유지.
- **검증**: 목록에서 회색 "데이터 없음" 텍스트 0건. 점수 있는 행의 배지는 그대로.
- **의존**: A-6 과 자리 공유.

### D-2. 무데이터 마커를 점으로

- **목표**: 줌 16에서 회색 라벨 마커가 겹쳐 지도가 안 읽힘. 점수 있는 곳만 라벨.
- **변경**: `MapView.tsx` `markerHtml` / 경량 마커(`:356-379`): `score == null` 이면 8px 회색 점(hover/selected 시에만 라벨 확장). zoom ≥ 18 에서는 전부 라벨. 상수는 파일 상단.
- **검증**: 서울 중구 zoom 16 스크린샷에서 라벨 수. 점 클릭/hover 동작.
- **의존**: B-3 과 묶으면 이름 제거와 정합.

### D-3. 상세 패널 빈 섹션 접기

- **목표**: 리뷰 0·영상 0·블로그 0 인 주차장에서 "없습니다" 3연속.
- **변경**: `ParkingDetailPanel.tsx` / `ParkingReputationSections.tsx`: 세 섹션이 모두 비면 한 줄 안내("아직 모인 후기가 없어요")로 합치고 `WriteReviewSection` 을 주차장 정보 바로 아래로 올린다. 하나라도 있으면 지금 배치.
- **검증**: 경향신문 주차장(MODU-109427) 상세에서 빈 섹션 0개, 별점 CTA가 첫 스크롤 안에.
- **의존**: 없음.

### D-4. 둘러보기 큐레이션 품질 게이트

- **목표**: 첫 줄에 오염 데이터. "주차장"(이름만, 해운대 6면, 블로그 53건), "시화공단 내 도로" ×3, "교원내외빌딩주차장출구", "인천공항 주차대행".
- **변경**
  - `src/server/parking.ts:800-820` 랭킹 쿼리 + 위키 허브 랭킹(`src/routes/wiki/index.tsx` 또는 `RankingSection.tsx` 데이터 소스): 공통 필터 `lib/lot-name-quality.ts` — 이름 길이 ≥ 4, 금지어(도로, 출구, 입구, 대행, 세차, 임시), 이름 정규화 후 dedupe(같은 이름은 상위 1개). "주차장"과 "주차장 앞" 류 generic 이름은 `isGenericName`(`crawlers/lib/scoring.ts`) 재사용.
  - "주차장"(해운대) 은 오매칭 의심 → `project_wrong_region_matching` 기준으로 web_sources 재검토 대상 목록에 추가.
- **검증**: 둘러보기 4개 섹션 상위 9개에 금지어/중복 0건.
- **의존**: A-4 (병합 후 dedupe가 줄어든다).

### D-5. 위키 소소한 수정

- `src/components/wiki/LotHeroSection.tsx` 혜택 문구 "혜택CGV" 구분자(레이블과 값 사이 `: ` 또는 줄바꿈).
- 주변 비교표(`AlternativeLotsSection.tsx`) "확인 필요" 는 요금 없음일 때 "—" 로.
- 주차면 빈칸은 공공데이터 미보강 13,641곳 처리(`scripts/enrich-from-public-data.ts`)로 채움. 별도 데이터 작업(`project_public_data_sync_2026_09`)에 편입.
- **의존**: 없음.

### D-6. 사이드바 visibleCount 초기화 버그

- `ParkingSidebar.tsx:42-44` effect deps `[]` → `[parkingLots]`. 주석 의도대로 목록이 바뀌면 20개로 리셋.
- **의존**: 없음. C-1 PR에 끼워도 된다.

---

## 권장 순서

**A 부터 순차 진행** (2026-09-10 사용자 지시).

| 순서 | 작업 | 이유 |
|---|---|---|
| 1 | **A-1** | 우선순위 역전 + 재크롤 주기. 22,084곳이 영구 기아 상태다. 변경은 작고 효과가 가장 크다 |
| 2 | **A-4** | 가장 큰 데이터 레버. 사람 판정 게이트 있음 |
| 3 | **A-2** | A-4 뒤에 해야 병합된 lot 기준으로 우선순위가 잡힌다 |
| 4 | **A-3** | 스크립트 1개 + 크론 스테이지 |
| 5 | **A-5** | 삭제 정책이 계속 지우고 있으므로 빠를수록 좋다 |
| 6 | **A-6** | D-1 과 함께 |
| 7 | C-1 + C-2 + D-6 | 사용자가 직접 겪은 불편, 변경 작음 |
| 8 | B-1 + B-2 | 목록이 임의라는 문제 |
| 9 | D-4 | 첫 화면 신뢰. 쿼리 필터만 |
| 10 | D-1 + A-6 | 배지 제거 자리에 별점 |
| 11 | D-3 | 상세 패널 |
| 12 | B-3 + D-2 | 포인트 경량화, 원인 확정 후 |
| 13 | D-5 | 나머지 |

## 진행 기록

| 작업 | 브랜치/PR | 상태 | 평가 결과 |
|---|---|---|---|
| A-1 | #198 (머지·배포·reprice 완료 09-10) | **완료** | 즉시 항목 1~4 통과. 5~7 은 09-11 / 09-17 재측정 |
| A-2 | #199 (머지·배포 완료 09-10) | **부분 완료** | 플러밍 완료·4곳 고정 확인. 전체 적용은 GA4 CSV 대기 |
| A-3 | (진행) | **재시도 필요** | 검증 1차 오탐 14/20 → 미적용·격리. 크롤러 가드는 적용 |
| A-3 | | | |
| A-4 | | | |
| A-5 | | | |
| A-6 | | | |

## 보류·하지 않는 것

- 네이버 크롤 전용 크론 슬롯(처리량 2배): 체감 게이트가 요약 처리량(144곳/일)과 필터 pass율이라 raw만 늘려선 안 보인다. A-2 로 예산 방향을 바꾼 뒤 필요하면 재검토.
- 헤더 수치 통합: 유지.
- 네이버 플레이스 스크래핑, 카카오 필드 저장: ToS 문제(`project_kakao_local_api_tos`).
