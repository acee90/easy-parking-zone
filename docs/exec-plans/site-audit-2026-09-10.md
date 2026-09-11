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
| 5 | web_sources 0건 주차장 수 | `SELECT COUNT(*) FROM parking_lots p LEFT JOIN (SELECT DISTINCT parking_lot_id id FROM web_sources) w ON w.id=p.id WHERE w.id IS NULL` | **43,172** | **1주 뒤 −3,000 이상** (600곳/일 × 7일 중 매칭 성공분) | +7일 | **중간값 (09-11, 약 21시간): 크롤로 첫 근거를 얻은 lot 64곳 → 1주 환산 약 450곳. 목표 미달 예상.** 배포 후 naver 가 크롤한 497곳 중 근거가 붙은 곳은 52곳(약 10%). 파이프라인 적체는 없다(본문 대기 0, 필터 대기 69, 매칭 대기 100) — **병목은 처리량이 아니라 수율**이다. 근거 0건 lot 은 대부분 블로그에 거의 안 나오는 소규모 공영 주차장이다. 기대값을 「크롤한 lot 대부분에 근거가 붙는다」는 가정으로 세운 게 틀렸다. 최종 판정 09-17 |
| 6 | 크롤 처리량 (선정 수) | 배포 후 `next_at` 이 80일+ 뒤로 밀린 큐 행 (= 배포 후 크롤된 lot) | 600곳/일 | **변동 없음** (±10%). 줄면 큐 조회가 깨진 것 | +1일 | **✅ 약 21시간에 naver 500 / ddg 550 → 일 환산 약 570곳.** 그중 95%(474/500)가 priority ≤0 — 근거 0건 lot 이 실제로 먼저 크롤되고 있다 |
| 7 | D1 rows_read | `EXPLAIN QUERY PLAN` (선정 쿼리) | covering index | **증가 없음** (같은 인덱스 조회) | +1일 | **✅ `SEARCH q USING COVERING INDEX idx_crawl_queue_pick` 그대로** |

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
| 1 | 고정 대상 lot 이 priority −1·next_at 도래 상태인가 | 입력 CSV의 lot_id 를 crawl_queue 와 조인 | 0% | **100%** | 스크립트 직후 | **✅ 763곳 전부 (크롤러 4종 × 764행, 1행은 09-10 고정분).** naver 선정 순서 앞 600칸이 전부 고정분 |
| 2 | syncQueue 1회 실행 후에도 고정이 유지되는가 | 다음날 `pinned_at IS NOT NULL AND priority=-1` 카운트 | — | **감소 0** | +1일 | **✅ 09-10 고정 4곳이 09-11 에도 크롤러 4종 모두 −1 유지** |
| 3 | 대상 lot 중 web_sources ≥1 비율 | web_sources 조인 | 0% (PV 있는데 근거 0) | **≥ 60%** | +7일 | |
| 4 | 첫 화면(서울 중구 zoom 14) 목록 20행 중 "데이터 없음" | 브라우저 실측 | **11/20 = 55%** | **≤ 30%** | +14일 | |

- **판정**: 1·2 가 즉시 판정, 3·4 는 관측. 2가 실패하면 마이그레이션 추가 후 재적용.
- **적용 (2026-09-11 05:46 UTC)**: GA4 CSV 를 따로 받지 않고 연결된 Supermetrics(GA4 속성 「쉬운주차장」 527471441)로 최근 30일 `/wiki/` 페이지별 조회수를 직접 받았다 → `data/traffic-lots-20260911.csv`.
  - 위키 조회가 있는 lot 8,137곳 (PV ≥5: 2,731곳 / ≥10: 1,535곳 / ≥50: 177곳)
  - PV ≥5 중 이미 web_sources 가 있는 1,950곳 제외, DB 에 없는 id 18개(주로 A-4 흡수분) 제외 → **763곳 고정**
  - naver 처리 능력(약 600곳/일)으로 1~2일이면 소진된다. 그동안 근거 0건 priority 0 큐는 잠시 뒤로 밀린다
  - 되돌리기: `bun run scripts/pin-crawl-priority.ts --remote --unpin --apply`
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
| 1 | 검증 대기 raw | `source='youtube_video' AND filter_passed IS NULL` | **1,742** | **≤ 100** | apply 후 | **✅ 39** (추출 이후 새로 들어온 분) |
| 2 | 통과율 | passed ÷ total | — | ~~15~50%~~ | 검증 직후 | **2.0% (35/1,742).** 1차에서 이 밴드가 판정자의 앵커가 됐다 — 기준에서 뺐다. 사후 관측값으로만 기록 |
| 3 | `parking_media` 유튜브 건수 | COUNT | **211건 / 78곳** | **≥ 500건** | apply 후 | **✗ 246건 (+35).** 기대값을 잘못 세웠다 — 백로그의 98% 가 잡음이었다 |
| 4 | 영상 있는 주차장 수 | `COUNT(DISTINCT parking_lot_id)` | **78곳** | **≥ 250곳** | apply 후 | **✗ 107곳 (+29).** 같은 이유 |
| 5 | 추가 YouTube 쿼터 소모 | 콜 수 | — | **0** (이미 값을 치른 데이터) | apply 후 | **✅ 0** |
| 6 | 통과분 사람 검수 | 수동 | — | 오탐 **≤ 1건** | apply 전 | **✅ 규칙 통과 59건 전수 검수 → 35건만 적용.** 적용분 오탐 0 (정의상) |

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

#### A-3 2차 시도 결과 (2026-09-11) — **35건 적용**

1차에서 배운 대로 판정자에게 통과율을 알려주지 않고, 기계적으로 걸러낼 수 있는 것부터 걸렀다.

| 단계 | 방법 | 남은 건수 |
|---|---|---|
| 0 | 검증 대기 `youtube_video` raw | 1,742 |
| 1 | **결정적 필터**: 대상 주차장 핵심 이름이 영상 제목·설명·태그 어디에도 없으면 탈락 (판정 규칙상 원래 탈락) | 461 |
| 2 | **제목 규칙**: 제목에 핵심 이름과 「주차」가 모두 있고, 부동산·동호인·맛집 패턴이 없어야 함 | 59 |
| 3 | **59건 전수 수동 검수** | **35** |

- 2단계와 나란히 Haiku 4개 샤드로 AI 판정도 돌렸다(근거 문자열 필수, 통과율 언급 없음). 샤드 04 통과 30건을 수동 검수하니 **오탐이 13~16건**이었다 — 설명에 "주차 가능"만 있는 부동산·식당 글을 규칙 A 로 통과시켰다. **AI 판정은 최종 결정에 쓰지 않았다.**
- 제목 규칙만으로는 정밀도 약 66%(59건 중 24건 탈락)라 자동 적용하지 않고 전수 검수했다. 탈락: 불법주차·지역 주차문제 영상, 다른 주차장(코스트코 고척·교회), 리스티클, 경치·등산, 식당. 등산 중 주차장만 스치는 경계 사례 4건도 뺐다.
- 규칙 정의(재현용): 제목 탈락 패턴 — 부동산 `매매|분양|임대|전세|월세|평형|세대|입주|상가|공장|모텔|보증금|억원|㎡|단지|사전점검|급매|오피스텔|빌라|아파트|부동산|경매|매물`, 동호인 `탑사기|엘리베이터|엘베|경광등|답사기|승강기|에스컬레이터`, 맛집 `맛집|메뉴|카페|빵|식당|중식|한식|술집|먹방|디저트`.
- 적용: `apply-youtube-verify.ts` 로 SQL 생성 → `wrangler --file` (1,778행 변경). 탈락 1,707건은 `filter_passed=0` 으로 종결돼 다음 크론 purge 대상이 된다.
- **기대값을 틀리게 세웠다.** 계획의 「parking_media ≥ 500건 / 영상 있는 주차장 ≥ 250곳」은 백로그가 대부분 쓸 만하다는 가정이었다. 실제로는 1,742건 중 이 주차장의 주차 영상은 35건(2%)뿐이었다. 백로그 대부분은 공공데이터 일반명으로 검색해 딸려온 잡음이다 — 크롤러 가드(PR #200)가 앞으로 이 잡음을 사지 않게 막는다.

### A-4. 출처 간 중복 병합

- **목표**: KA ↔ 공공 ↔ MODU ↔ NV 간 같은 주차장을 하나로. 리뷰·웹 글이 중복에 쪼개지는 희석 해소. 새 데이터 없이 곳당 신호가 늘어나는 유일한 레버.
- **변경**
  - `scripts/find-cross-source-dupes.ts` (읽기 전용): 60m 이내 교차 출처 쌍을 **쌍 단위**로 판정한다 (MODU 내부 정리의 그룹 단위 절단 허점을 피한다).
    A = 정규화 이름 완전 일치 + 반대 신호 없음 / B = 브랜드 제거 후 일치·포함 관계 / C = 주소만 일치.
    반대 신호(공영/민영 엇갈림, 번호·동·차수 차이, 면수 2배 차이)가 있으면 A → B.
  - `scripts/merge-cross-source-dupes.ts`: A 등급(체인 제외)만. 백업 JSON + SQL 생성 → `--apply`.
    대표 = 유저 리뷰 > 공공데이터 > MODU·HP > NV > KA. 유니크 표는 `UPDATE OR IGNORE` 후 잔여 삭제.
  - **계획 변경: `merged_into` soft-merge 대신 삭제 + `lot_redirects`(0059) 301.** `parking_lots` 를 읽는 경로가 14개 파일이라 하나라도 필터를 빠뜨리면 중복이 되살아난다.
  - **계획 변경: 재계산은 큐에 직접 넣지 않고 옮긴 `web_sources.matched_at` 을 올린다.** 크론 재계산 스테이지가 `matched_at > computed_at` 인 lot 만 집기 때문이다 (스크립트에서는 큐 바인딩이 없다).

#### A-4 평가항목

| # | 지표 | 측정 | 기준선 (09-10) | 기대값 | 시점 | 결과 |
|---|---|---|---|---|---|---|
| 1 | 후보 쌍 수 / 자동확정 / 보류 | `data/a4/cross-source-dupes.json` | 미측정 | 보류 비율 **≤ 30%**. 넘으면 규칙이 느슨함 | 스크립트 직후 | **1,599쌍 (A 211 / B 577 / C 811), 보류 87% ✗** — 기준 자체가 잘못 세워졌다. 아래 참고 |
| 2 | 자동확정 표본 30쌍 사람 검수 정확도 | 수동 | — | **≥ 97%** (오탐 1건 이하). 미만이면 병합 중단 | 병합 전 | **30/30, 오탐 0 ✅** |
| 3 | 첫 화면(서울 중구 zoom 14) 20행 중 중복 쌍 | 브라우저 실측 | **4쌍** | **0쌍** | 병합 후 | **1쌍 해소 (미근동) △** — 나머지 3쌍은 아래 참고 |
| 4 | 병합 lot 의 web_sources·review 합산 | 대표 lot 전후 비교 (전수) | — | **손실 0건** (합계 보존) | 병합 후 | **web_sources 363→363, 리뷰·미디어·주변장소 보존 ✅** |
| 5 | parking_lots 노출 수 감소분 | 사이트맵 URL 수 | 20,601 | **= 흡수 lot 수** (±0) | 병합 후 | **20,471 (−130) ✅** 설명 일치 — 아래 참고 |
| 6 | 병합 lot 의 final_score 재계산 | `parking_lot_stats.computed_at` | — | **전건 재계산** | 병합 +1 크론 | **✅ 105/105.** `matched_at` 을 올린 대표 lot 105곳이 09-11 06:09 UTC 크론에서 전부 재계산됐다 (stats 행 없는 곳 0) |

- **판정**: 2가 게이트다. 97% 미만이면 병합 SQL 을 적용하지 않는다 (정확도 > 재현율).

#### A-4 1차 결과 (2026-09-11 적용)

PR #201 머지 → 배포 → 0059 적용 → 병합 SQL 4개 적용. **207쌍 병합, parking_lots 54,072 → 53,865.**
백업은 `data/a4/merge-backup-202609110453.json` (흡수 lot 207행 + 자식 443행).
`/wiki/…-KA-27190610` → `/wiki/미근동-공영-112-2-000004` 301 과 존재하지 않는 id 의 404 를 실서비스에서 확인했다.

| 대표 ← 흡수 | 쌍 |
|---|---|
| 공공데이터 ← KA | 188 |
| 공공데이터 ← NV | 11 |
| NV ← KA | 7 |
| KA ← 공공데이터 | 1 |

**항목별 해석**

- **#1 은 기준을 잘못 세웠다.** B·C 는 설계상 보류 등급이라 보류 비율이 높다는 건 규칙이 느슨하다는 뜻이 아니라 **보수적**이라는 뜻이다. 의미 있는 지표는 A 의 정밀도(#2)이고 그건 통과했다.
- **#3 의 4쌍 중 해소는 미근동 1쌍뿐이다.**
  - 바비엥 ×2 는 **중복이 아니었다.** 「바비엥3차」(HP-214)와 「바비엥 주차장」(MODU-181814)은 다른 건물이다. 09-10 점검의 관찰이 틀렸다.
  - 이화여고앞 ×2 는 이름·면수(13)가 같지만 **106m** 떨어져 있다 (공공 좌표는 입구, 카카오는 중심). 이번 60m 규칙 밖이다.
  - 서대문KG타워 ×2 는 **같은 출처(MODU↔MODU)** 이고 한쪽에 「투루파킹」 접두가 붙어 있다. 교차 출처 병합의 대상이 아니다.
- **#4 에서 destination_lots −7, cafe_signal_lots −84 는 손실이 아니다.** 두 lot 이 같은 목적지·신호에 이미 연결돼 있어 유니크 키로 합쳐진 것이다.
- **#5 의 −130 은 정확히 설명된다.** 흡수 lot 중 병합 전 사이트맵에 있던 것 141곳이 빠지고, 근거가 늘어난 대표 lot 11곳이 색인 게이트를 새로 넘었다 (−141 + 11 = −130).
- **적용 중 사고:** 첫 SQL 파일에서 wrangler 가 비정상 종료했지만 SQL 은 전부 반영돼 있었다. 상태를 SELECT 로 확인한 뒤 나머지 3개만 직접 적용했다. 스크립트를 통째로 다시 돌렸다면 백업 단계에서 「행 수 ≠ 계획」으로 멈췄을 것이다.

**후속 (2차 라운드 후보)**

| 대상 | 규모 | 메모 |
|---|---|---|
| 교차 출처 동명 쌍 60–100m | 250쌍 | 이화여고앞 유형. 등급을 따로 두고 같은 표본 게이트 |
| 교차 출처 동명 쌍 100–200m | 243쌍 | 오탐 위험이 커서 주소 일치를 추가 조건으로 |
| MODU↔MODU 브랜드 접두 쌍 ≤60m | 8쌍 | 서대문KG타워 유형. 전건 수동 확인 가능 |
| B 등급 보류 | 577쌍 | 브랜드·포함 관계. 표본부터 |
| C 등급 보류 | 811쌍 | 주소만 일치. 오탐 다수 예상 |
- **의존**: 없음. 단, **MODU 내부 중복 보류 11쌍**(`project_modu_intra_dedup_2026_09`)과 같은 판정 기준을 쓴다.

### A-5. 크론 매칭 실패분을 `web_sources_missed` 에 남기기 (원래 계획에서 방향 수정)

> **09-11 실측으로 전제가 바뀌었다.** 원래 계획은 "`[GHOST_POI]` 사유 raw 가 삭제 정책에
> 먼저 지워지니 삭제 전에 새 표로 옮긴다"였다. 확인해 보니:
>
> - **`[GHOST_POI]` 를 쓰는 코드가 없다.** `issue-body.md` 의 일회성 수동 매칭 실행에서 나온 표기다.
> - remote `web_sources_raw` 에 `match_fail_reason` 이 채워진 행이 **0건**이다. 삭제가 먼저 지운 게 아니라 **애초에 아무도 안 쓴다.**
> - 「DB 에 없는 주차장을 언급한 글」을 모으는 표는 **이미 있다: `web_sources_missed` (0041).**
>   20,132행, 미해결 19,114행. 해결·등록용 스크립트도 이미 있다
>   (`discover-missed-parking-lots`, `resolve-missed`, `relink-existing-missed`, `register-new-lots`).
> - 그런데 **2026-08-19 이후 새 행이 0건이다.** 쓰는 곳이 수동 스크립트(`run-pipeline-149`)뿐이고,
>   파이프라인이 크론으로 넘어간 뒤 크론 매처(`match-to-lots.ts`)는 이 표를 쓰지 않는다.
>
> 크론 매처는 시도한 raw 에 결과와 무관하게 `matched_at` 을 찍고, 종결 조건(`raw-retention.ts`)이
> `matched_at IS NOT NULL` 을 지운다. 그래서 **필터는 통과했는데 붙을 lot 이 없는 글이 하루 약 390건씩
> 흔적 없이 사라진다** (09-10: filter:pass 426, match:sources 35).

- **목표**: 크론 매처가 `run-pipeline-149` 와 **같은 조건**으로 미매칭 글을 `web_sources_missed` 에 남긴다. 새 표·새 AI 호출 없음.
- **변경**
  - `match-to-lots.ts`: 후보 0건(`keywords.length > 0 && candidates.length === 0`)이고 본문 수집이 `ok` 인 raw 는
    `missed_lot_name = extractSearchKeywords(...).join(' ')` 로 `INSERT OR IGNORE INTO web_sources_missed`.
    `source_id` 가 UNIQUE 라 재실행해도 안전하다. raw 에는 `match_fail_reason = 'lot_not_in_db'` 를 찍는다.
  - 노이즈 이름(`isNoiseLotName`)이면 missed 에 넣지 않고 `match_fail_reason = 'noise_name'` 만 찍는다 (missed 재오염 방지 — pipeline-149 와 같은 규칙).
  - 이름 추출과 노이즈 판정은 `scripts/` 에만 있어 워커가 못 쓴다.
    - `scripts/lib/missed-classify.ts` → `src/server/crawlers/lib/missed-classify.ts` 로 옮기고, 옛 경로는 re-export 한 줄로 남겨 이를 쓰는 스크립트 5개는 그대로 둔다.
    - `src/server/crawlers/lib/missed-name.ts`: `run-pipeline-149` 의 장소명 추출기와 `isNoiseLotName` 을 옮겼다.
      크론 매처의 `extractSearchKeywords` 는 FTS 검색용(앞 5단어)이라 이름으로 쓰면 필러가 섞인다 — **매칭 키워드는 그대로 두고 missed 이름에만** 쓴다.
    - `run-pipeline-149.ts` 는 수동 레거시 파이프라인이라 손대지 않았다 (자체 사본 유지).

#### A-5 평가항목

| # | 지표 | 측정 | 기준선 (09-11) | 기대값 | 시점 | 결과 |
|---|---|---|---|---|---|---|
| 1 | `web_sources_missed` 신규 행 | `created_at > 배포 시각` | **0건/일** (08-19 이후 0) | **≥ 30건/일** | +1일 | 중간값 (09-11 06:00 크론 1회, 매칭 raw 약 14건): **0건.** 크론 raw 는 특정 주차장을 검색해 모은 글이라 FTS 후보 0건이 드물다. 30건/일 기대값은 수동 파이프라인(대량 일괄) 기준이라 과할 수 있다 — 09-12 하루치로 판정 |
| 2 | ~~신규 raw 중 `match_fail_reason` 기록 비율~~ → **`pipeline_daily_stats` 의 `match:missed` / `match:noise_name`** | 일별 카운터 | 0 | 후보 0건 raw 가 생기면 두 카운터 합 = 그 수 | +1일 | **측정 설계 수정.** 매칭 끝난 raw 는 같은 크론의 purge 가 곧바로 지워 `match_fail_reason` 을 사후에 볼 수 없다(09-11 실측: 매칭 raw 전부 삭제됨). 매처가 두 카운터를 반환하고 크론이 일일 통계에 남기도록 고쳤다 |
| 3 | 신규 missed 상위 20 이름 중 실제 장소명 비율 | 수동 검수 | — | **≥ 50%**. 미만이면 노이즈 규칙 보강 | +7일 | |
| 4 | 매칭 단계 처리량 | `pipeline_daily_stats` match:* | 현행 | **변동 ≤ 10%** (DB 쓰기 1건 추가뿐) | +1일 | |

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
| 4 | 스팸·저품질 유입 | 같은 ip_hash 다건, 코멘트 없는 극단 별점 비율 | **IP당 최대 1건/7일, 최근 24시간 0건** (09-11 배포 직후) | **비정상 급증 없음**. 있으면 rate limit 강화 | +14일 | |

- **판정**: 1이 본 지표, 2·3은 훅별 기여도. 4는 안전 장치.

#### A-6 구현 메모 (2026-09-11)

- **재방문 프롬프트**: `NavigationButton` 에서 길찾기 앱 링크를 누르는 순간 `src/lib/last-nav.ts` 가 lot id·이름·시각을 localStorage 에 남긴다 (서버로 보내지 않는다). `RevisitPrompt` 가 `__root.tsx` 에 붙어 모든 페이지(관리자 제외)에서 2시간~14일 된 기록을 한 번 꺼내 토스트로 묻는다.
  - `ParkingActionGroup` 이 lot id 를 모르던 구조라 `lotId` prop 을 추가하고 호출부 3곳(지도 상세 패널·카드·위키 위치 섹션)에서 넘긴다.
  - **토스트는 1.2초 뒤에 띄운다.** `RevisitPrompt` 의 effect 가 `<body>` 끝의 `<Toaster>` 구독보다 먼저 돌아 즉시 만든 토스트가 버려졌다 (브라우저 실측: 기록은 소비됐는데 토스트가 안 떴다).
- **목록 인라인 별점**: 지도 사이드바·모바일 목록에서 점수 없는 행의 「데이터 없음」 배지를 지우고(D-1 의 목록 부분) 그 아래 `QuickRating` 을 둔다. 행이 `<button>` 이라 별점(버튼 10개)을 안에 넣을 수 없어 형제로 뺐다.
- **계획과 다른 점 — 별을 고른 뒤 「N점 등록」을 한 번 더 누르게 했다.** 계획은 "탭하면 즉시 등록"이었지만, 목록을 스크롤하다 별을 스치기만 해도 리뷰가 올라가면 난이도 점수(final_score)가 흔들린다. 평가항목 4(스팸·저품질)를 지키기 위한 확인 한 번이다.
- 등록은 상세 패널의 `ReviewForm` 과 같은 `createReview` 호출(총점을 다섯 항목에 동일하게)이다. 서버 쪽 24시간 중복 제한이 그대로 적용된다.
- GA4: `review_prompt_shown`, `review_prompt_rated`, `inline_rating_submitted` (`src/lib/analytics.ts` — gtag 가 없으면 조용히 무시).
- 검증: `last-nav.test.ts` 6건, `QuickRating.test.tsx` 3건(확인 전 미등록·페이로드·거절 시 복귀). 로컬 dev 가 리모트 D1 을 읽는 모드라 브라우저에서는 「등록」을 누르지 않고 확인 버튼 노출까지만 확인했다.
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
| A-2 | #199 + GA4 적용 09-11 05:46 UTC | **완료** | GA4(Supermetrics) 30일 위키 PV ≥5 중 근거 0건 **763곳 고정**. 즉시 항목 1·2 통과, 3·4 는 +7일·+14일 |
| A-3 | #200 + 2차 적용 09-11 | **완료** | 1차 오탐 14/20 → 격리. 2차: 결정적 필터→제목 규칙→전수 검수로 **35건 적용 (29곳)**. 기대값(≥500건)은 잘못 세운 목표로 판명 |
| A-3 | | | |
| A-4 | #201 (머지·배포·병합 적용 09-11) | **완료 (1차)** | 207쌍 병합, 표본 오탐 0/30, web_sources 손실 0, 사이트맵 −130 설명 일치. 재계산은 09-11 06:00 UTC 크론 확인 대기 |
| A-5 | #203 (머지·배포 09-11 05:08 UTC) | **배포됨, 관측 대기** | 계획 수정: 새 표 대신 기존 `web_sources_missed` 에 크론이 기록. 신규 행·기록 비율은 09-12 측정 |
| A-6 | (이 PR) | **배포됨, 관측 대기** | 재방문 프롬프트·목록 인라인 별점. 테스트 9건, 데스크톱·모바일 브라우저 확인. 전환율은 GA4 로 +14일 |

## 보류·하지 않는 것

- 네이버 크롤 전용 크론 슬롯(처리량 2배): 체감 게이트가 요약 처리량(144곳/일)과 필터 pass율이라 raw만 늘려선 안 보인다. A-2 로 예산 방향을 바꾼 뒤 필요하면 재검토.
- 헤더 수치 통합: 유지.
- 네이버 플레이스 스크래핑, 카카오 필드 저장: ToS 문제(`project_kakao_local_api_tos`).
