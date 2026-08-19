# D1 무료 플랜 전환 전략 (500MB 이하)

작성 2026-08-18 · 대상 DB `parking-db` (ff5d77af-8ca6-4e5c-acf2-2fdf765dd248)

## 결론 요약

1. **크롤링 데이터를 다 버릴 필요는 없다.** 서비스가 실제로 쓰는 데이터는 전부 합쳐 **~25MB**다. 1.35GB는 거의 전부 `web_sources_raw`의 본문/스니펫과 그 인덱스·단편화다.
2. **본문을 다 지워도 500MB에 못 간다.** 원인은 **페이지 내부의 죽은 공간**이다(free page 아님 — 2장 참조). local 사본 실측: 현재 1.398GB → `VACUUM`만 하면 **594MB** → raw slim까지 하면 **194MB**. D1 remote는 `VACUUM`이 차단돼 있으므로 → **신규 DB 재구축이 유일한 해법.**
3. **진짜 게이트는 용량이 아니라 일일 쿼터다.** 무료는 rows read 5M/일, rows written 100k/일. 현재 크롤 물량이 이 안에 들어가는지가 go/no-go다. 여기서 막히면 용량 작업은 의미가 없다.
4. **절감액은 월 $5다.** 유료 플랜 포함 스토리지가 5GB라 현재 1.35GB는 추가 과금이 전혀 없다. 즉 이 작업은 비용 최적화가 아니라 **월 $5를 위해 쿼터 제약과 크롤 축소를 감수하는 트레이드**다.

## 1. 현황 측정 (2026-08-18)

purge 직후 DB 크기 **1.354 GB**.

| 구분 | 행수 | 텍스트 payload |
|---|---:|---:|
| `web_sources_raw` | 572,675 | **~193 MB** (full_text 89 · content 75 · url 36 · title 18 · source_id 9) |
| `web_sources` (서비스) | 21,895 | 8 MB |
| `web_sources_missed` | 19,970 | 4 MB |
| `parking_lots` | 31,994 | <1 MB |
| `parking_lot_stats` | 31,939 | <1 MB |
| `cafe_signals` | 16,754 | — |
| `parking_lots_fts_*` | 459 blocks | 1 MB |
| **페이지 내부 죽은 공간 + 인덱스** | | **~1.15 GB** |

### 왜 지워도 안 줄어드는가 — 페이지 내부 죽은 공간

remote D1은 `dbstat`/`pragma`/`VACUUM`이 전부 `SQLITE_AUTH`로 차단된다. 그래서 **local 사본으로 실측**했다(구조가 동일하므로 유효).

- `freelist_count` = 187 페이지 = **0.1%**. 즉 "완전히 빈 페이지"는 사실상 없다. `auto_vacuum=0`.
- 그런데 `web_sources_raw`의 실제 텍스트는 **202 MB**인데 `dbstat` 점유는 **1,208 MB**. 행당 평균 2.1KB 페이지를 점유하면서 실제 사용은 0.34KB → **83%가 페이지 내부의 죽은 공간**이다.
- 이유: SQLite는 4KB 페이지 단위로 저장하는데, `UPDATE ... SET full_text=NULL`로 행이 작아져도 **페이지를 OS에 반납하지 않는다.** 빈 자리는 같은 페이지 안에서만 재사용된다. 그래서 purge를 해도 파일이 안 줄고, 다음 크롤은 새 페이지를 또 할당한다 — "지우는데도 계속 커지는" 이유가 이것이다.

**VACUUM 실측** (local 1.398GB 사본, 13초):

| 상태 | 크기 |
|---|---:|
| 현재 | 1.398 GB |
| `VACUUM`만 | **594 MB** |
| raw slim + `VACUUM` | **194 MB** ✅ |

slim = `full_text`/`content`/`title`/`source_url`/`author`/`ai_summary` 비우기 + `idx_raw_source_url`·`idx_raw_fulltext_status` 삭제.

**증가 속도**: 최근 7일 평균 크롤 유입 **~5,000행/일**. 6일간 DB가 1.18 → 1.54GB (약 60MB/일) 증가했다.

**근본 원인**: `src/server/` 전체에 purge 로직이 **존재하지 않는다** (`grep -rn "purged" src/server/` → 0건). cron은 30분마다 크롤+본문수집만 하고, 본문 정리는 `/run-pipeline` 스킬의 수동 단계로만 존재한다. 즉 사람이 개입하지 않으면 무한 증가한다.

## 2. Gate 0 — 일일 쿼터 확인 (go/no-go, 최우선)

**이걸 먼저 확인하지 않으면 나머지 작업이 전부 헛수고가 될 수 있다.**

확인처: Cloudflare 대시보드 → Workers & Pages → D1 → parking-db → Metrics (일별 rows read / rows written).
※ `D1_PROXY_TOKEN`에는 analytics 권한이 없어 스크립트로는 못 읽는다 (`not authorized for that account`).

판정 기준:

| 지표 | 무료 한도 | 우려 |
|---|---|---|
| rows written | 100k/일 | **근접 예상.** write는 인덱스 갱신까지 센다 — 실측으로 `UPDATE` 300건 = 1,200 rows written(인덱스 4개). raw는 인덱스 5개라 INSERT 1행 ≈ 6 write. 5,000행/일 → 30k, 여기에 fulltext·filter·match UPDATE가 더해진다. |
| rows read | 5M/일 | **초과 위험 큼.** 상태 집계 쿼리 하나가 541k행을 읽었다. cron이 하루 48회 도는데 full scan이 섞여 있으면 쉽게 5M을 넘는다. |

- **둘 다 여유 있음** → 3장으로 진행.
- **read가 초과** → 인덱스 보강으로 full scan을 없애거나, cron 주기를 30분 → 2~4시간으로 낮춰야 한다. 크롤 물량 축소는 제품 결정이므로 별도 판단 필요.
- **write가 초과** → 크롤 유입량 자체를 줄여야 한다(5,000행/일 → 1,500행/일 수준).

## 3. 전환 전략

### Phase 1 — 정리 (재구축 전 준비)

1. **미처리 백로그 드레인 1라운드.** 현재 `filter_passed IS NULL AND full_text_status='ok'` 7,633행(89MB)이 남아 있다. 이건 cron이 본문만 받고 분류를 안 한 것이라, 지금 지우면 본문 없는 zombie가 되고 나중에 재수집해야 한다(회수율 59~82%). **재구축 전에 `/run-pipeline` 1라운드로 처리하는 게 싸다.**
2. **full_text purge** — 완료(189MB 회수). 조건은 반드시 terminal(`filter_passed=0 OR matched_at IS NOT NULL`). `ai_filtered_at IS NOT NULL`로 잡으면 lot-match 대기분 본문까지 날려 zombie가 된다(2026-06-09 사고).

### Phase 2 — 신규 DB 재구축 (핵심)

단편화 회수는 이 방법뿐이다. 새 D1을 만들고 **필요한 것만** 복사한 뒤 바인딩을 교체한다.

**복사 대상 (keep-set)**

| 테이블 | 처리 |
|---|---|
| `parking_lots`, `parking_lot_stats`, `parking_lots_fts_*` | 전량 복사 |
| `web_sources` | 전량 복사 (서비스 핵심) |
| `web_sources_missed` | 전량 복사 |
| `cafe_signals`, `cafe_signal_lots`, `nearby_places`, `parking_media` | 전량 복사 |
| `user`, `session`, `account`, `verification`, `user_reviews`, `parking_bookmarks`, `parking_votes`, 각종 `*_reports` | 전량 복사 |
| `web_sources_raw` | **slim ledger로만 복사** (아래) |
| `web_source_ai_matches` (0행), `poi_unmatched`, `crawl_progress` | 필요성 재검토 후 결정 |

**`web_sources_raw` slim ledger**

이 테이블이 런타임에 쓰이는 곳은 없다 — 참조는 `src/server/scheduled.ts`와 `src/server/crawlers/*`뿐이고 사용자 응답 경로에는 없다. 유일한 실질 가치는 **`UNIQUE(source, source_id)`를 통한 재크롤 방지(dedup)** 다.

**확정 정책 (2026-08-19 사용자 결정)**

- 남길 컬럼: `id`, `source`, `source_id`, **`source_url` (전량 보존)**, `crawled_at`, `filter_passed`, `matched_at`, `full_text_status`, `match_fail_reason`
- 버릴 컬럼: `full_text`, `content`, `title`, `author`, `ai_summary`, `ai_difficulty_keywords`, `search_lot_hint`
- `id`는 반드시 보존 — `web_sources.raw_source_id` FK가 걸려 있다.
- **인덱스**: `idx_raw_source_url`(33.6MB)은 **삭제**한다. `source_url`은 코드 전체에서 `LIKE 'http%'` 프리픽스 스캔에만 쓰이고 등가 조회가 없어 인덱스가 어떤 쿼리도 서빙하지 않는다(`grep` 확인). dedup용 `UNIQUE(source, source_id)`는 필수 유지, `idx_raw_filter`·`idx_raw_matched`·`idx_raw_fulltext_status`는 파이프라인 쿼리가 실제로 쓰므로 유지.

`source_url` 보존 비용은 **+39MB**에 불과하다(194MB → 233MB). `feedback_raw_cleanup_policy`의 "url+사유 보존" 요구와도 일치한다.

**실측 결과**: local 사본에 위 확정 정책을 그대로 적용하고 VACUUM한 결과 **233 MB** (raw 92 + web_sources 37 + UNIQUE인덱스 17 + fulltext_status인덱스 15 + missed 14 + filter인덱스 12 + 나머지). 500MB 대비 2배 이상 여유.

**실행 시 주의**

- `wrangler d1 export`는 대용량 테이블에서 행을 누락시킨다([[project_wrangler_d1_export_drops_rows]]). **`scripts/` 의 REST 페이징 복사 패턴을 쓰고 테이블마다 count 검증**할 것.
- `CF_DATABASE_ID`가 `src/db/index.ts:7`에 **하드코딩**돼 있다. `wrangler.jsonc`의 `database_id`, 스크립트에 박힌 UUID까지 전부 grep해서 교체.
- cron이 30분마다 쓰므로 **전환 중에는 트리거를 잠시 멈춘다**(안 그러면 그 구간 크롤이 유실).
- 검증 끝날 때까지 **기존 DB는 삭제하지 않는다.** push = 즉시 배포이므로, 전환 후 라이브 페이지 로드로 서버 fn을 검증할 것([[feedback_verify_serverfn_live_page]]).

### Phase 3 — 지속 통제 (안 하면 새 DB도 똑같이 찬다)

Phase 2만 하고 끝내면 60MB/일로 다시 차서 **8일 만에 500MB를 넘는다.** 코드 변경이 필수다.

1. **`scheduled.ts`에 purge 추가** — 매 cron 사이클 끝에 terminal 조건으로 full_text 비우기. 스킬의 수동 단계를 코드로 옮기는 것.

   ```sql
   UPDATE web_sources_raw SET full_text=NULL, full_text_status='purged'
   WHERE full_text_status='ok' AND full_text IS NOT NULL
     AND (filter_passed=0 OR matched_at IS NOT NULL)
   ```

   > **⚠️ 조건을 `ai_filtered_at IS NOT NULL`로 바꾸지 말 것.** "ai-filter 끝나면 full_text 불필요"는 직관적으로 맞아 보이지만 **틀렸다.** ① `ai_filtered_at`은 AI가 아니라 **rule filter(Stage 1)** 가 설정한다. ② lot-match(Stage 4)가 `raw.full_text`를 읽어 `pickBestLot`→`lotNameInFullText`/`lotCoreInText`로 주차장을 특정한다(`scripts/run-pipeline-149.ts:1240-1241`). 그래서 full_text가 정말 불필요해지는 시점은 **lot-match 완료(`matched_at IS NOT NULL`)** 이후다. 이 구분을 놓쳐서 2026-06-09에 본문 없는 영구 zombie를 만든 사고가 있었다([[project_pipeline_purge_zombie_bug]]). 위 terminal 조건이 **이미 "안전한 한도 내에서 가장 이른 시점"** 이다.
2. **retention trim** — N일(예: 30일) 지난 terminal raw는 ledger 컬럼만 남기고 `content`/`title`/`source_url` NULL 처리.
3. **크기 알람** — cron에서 주기적으로 크기를 찍고 임계(예: 350MB) 초과 시 로그 경고.

4. **월 1회 재구축 (운영 루틴 확정)** — 위 셋을 다 해도 **파일 크기는 줄지 않는다.** purge/retention은 새 페이지 할당을 막아 크기를 *고정*시킬 뿐이고, 실제 회수는 재구축(=VACUUM 대용)뿐이다.

   **주기: 매월 1회.** 근거 — 압축 안 된 상태의 원장은 행당 ~0.7KB, 유입 5,000행/일이면 월 ~105MB 증가한다. 194MB에서 시작하면 3개월이면 500MB에 닿으므로, 월 1회면 항상 300MB 이하로 유지된다.

   **루틴 (매월 1일, 소요 ~30분)**
   1. 크론 트리거 일시 중지
   2. `/run-pipeline` 1라운드로 in-flight 백로그 비우기 (미처리 본문이 남으면 재구축 후 재수집해야 함)
   3. 신규 D1 생성 → keep-set만 REST 페이징 복사 (테이블별 count 검증)
   4. `src/db/index.ts`의 `CF_DATABASE_ID` + `wrangler.jsonc`의 `database_id` 교체 → 배포
   5. 라이브 페이지 로드로 서버 fn 검증 → 이상 없으면 구 DB 삭제, 크론 재개
   6. 크기 기록 (다음 달 증가율 추적용)

1~3이 들어가면 정상 증가는 **~0.5MB/일** 수준(ledger 행만 누적)으로 떨어져, 재구축 주기를 길게 가져갈 수 있다.

## 4. 결정이 필요한 항목

- **Gate 0 결과** — 일일 쿼터가 무료 한도에 들어가는가? (대시보드 확인 필요)
- ~~`source_url` 보존 범위~~ → **전량 보존으로 확정** (2026-08-19)
- **full_text 저장 길이 축소 여부 (미결정, 효과 큼)** — 현재 `MAX_FULLTEXT_BYTES=30,000`으로 저장하지만, AI filter에 넘기는 건 `fullText.slice(0, 6000)`이고(`run-pipeline-149.ts:893,913`) lot-match도 주차장명 substring 매칭만 한다. **fetch 시점에 6,000자로 잘라 저장하면 full_text 용량이 대략 1/5**로 줄어 라운드 사이 누적분이 크게 감소한다. 리스크는 주차장명이 6,000자 뒤에만 등장하는 글의 매칭 실패인데, 표본으로 매칭률 영향을 먼저 재볼 수 있다.
- **크롤 cadence** — 쿼터 초과 시 cron 주기를 늘릴 것인가 (제품 영향)
- **월 $5 vs 운영 제약** — 유료 유지 시 이 작업 전체가 불필요하다. 다만 Phase 3(지속 통제)은 유료를 유지하더라도 할 가치가 있다(무한 증가는 언젠가 10GB에 닿는다).

## 참고

- D1 한도: 무료 500MB/DB · 5GB 계정 · 10DB · 5M read/일 · 100k write/일 / 유료 10GB/DB · 5GB 포함 · 25B read·50M write 월
- 관련 메모리: `project_d1_size_limit`, `project_d1_fragmentation_vacuum`, `feedback_raw_cleanup_policy`, `project_pipeline_purge_zombie_bug`
