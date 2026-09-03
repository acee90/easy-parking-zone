# 경쟁 사이트 목록

- **최초 작성**: 2026-09-02
- **용도**: 주기적 비교·벤치마킹, 그리고 크롤 결과에서 **집계 제외할 도메인 판정**
- **발견 방법**: 우리 `web_sources` 를 도메인별로 집계했다. 블로그는 주차장 1~2곳만 언급하지만, **주차장 DB 를 가진 사이트는 수백 곳에 걸쳐 등장**한다. 이 차이로 걸러냈다.

## 목록 재생성 방법

크롤이 쌓이면 새 사이트가 나타난다. 아래를 돌려 갱신한다.

```bash
npx wrangler d1 execute parking-db --remote --json --command "
SELECT CASE
    WHEN source_url LIKE 'http://%'  THEN substr(source_url, 8)
    WHEN source_url LIKE 'https://%' THEN substr(source_url, 9)
    ELSE source_url END AS rest, parking_lot_id
FROM web_sources WHERE source_url IS NOT NULL"
# → 호스트별 DISTINCT parking_lot_id 수로 정렬. 수십 곳 이상이면 DB 보유 사이트로 본다.
```

## 주차장 DB 보유 사이트 (2026-09-02 기준)

`lot 수` = 우리 주차장 중 그 사이트가 다루는 곳의 수. 클수록 DB 규모가 크다.

| 도메인 | lot 수 | 성격 | 비고 |
|---|---:|---|---|
| `placeview.co.kr` | 1,251 | 종합 장소 디렉터리 | 주차장은 업종 하나. 상세는 얕음(가시 텍스트 918자) |
| `dodam-platform.com` | 981 | **주차 전문** | `/parking-lots/{id}` · 면수·전화·요금·운영시간·1일·월정기 모두 노출 |
| `siteinfor.co.kr` | 498 | 장소 디렉터리 | |
| `parking.loveash.kr` | 447 | **주차 전문 (주차장모아)** | 가장 상세히 분석한 곳. 아래 별도 절 |
| `ilsangkit.co.kr` | 294 | 생활정보 | |
| `parking.mustarddata.com` | 277 | 주차 전문 | |
| `jucha.kr` | 260 | **주차 전문 (주차.kr)** | **URL 이 `?code={주차장관리번호}` — 우리 `parking_lots.id` 와 동일 체계** |
| `parking.govpped.com` | 229 | 주차 전문 | |
| `parking.worldtourlist.com` | 207 | 주차 전문 | |
| `junkangworld.com` | 187 | 생활정보 | |
| `k114.co.kr` | 176 | 전화번호부 계열 | |
| `platformdodam.com` | 171 | dodam 계열 | `dodam-platform.com` 과 동일 운영으로 추정 |
| `carhub.co.kr` | 148 | 자동차 정보 | |
| `locategrid.com` | 136 | 장소 디렉터리 | |
| `store114.net` | 114 | 업체 디렉터리 | |
| `visit.pluconnect.com` | 103 | 장소 디렉터리 | |
| `elecvery.com` | 98 | 전기차 충전 | 주차장과 겹침 |
| `parking.netfilcker.com` | 73 | 주차 전문 | |
| `place.udanax.org` | 73 | 장소 디렉터리 | |
| `car.bonuscookie.com` | 61 | 자동차 정보 | |

> ⚠️ `easy-parking.xyz` 가 **499 lot 으로 목록에 잡힌다 — 우리 사이트다.** 크롤러가 자기 사이트를 긁고 있다는 뜻이므로 수집 단계에서 제외해야 한다.

## 핵심 사실 — 이들 대부분은 우리와 같은 공공데이터를 쓴다

`jucha.kr` 은 푸터에 **"본 서비스는 공공데이터를 활용하여 주차장 정보를 제공합니다"** 라고 명시한다.
URL 도 `?code=161-2-000155` 로 **전국주차장정보표준데이터의 주차장관리번호를 그대로 쓴다** — 우리 `parking_lots.id` 와 같은 값이다.

**따라서 이들을 크롤해도 얻는 것은 공공데이터의 사본이다.** 우리가 이미 가진 것이고, 그 과정에서 상대의 오류까지 함께 들어온다
(`parking.loveash.kr/parking/9000` 은 요금이 비어 `0min 0` · "1시간 예상 요금은 0원입니다" 를 그대로 발행하고 있다).

결손을 메우려면 **원천으로 가는 편이 낫다** — 아래 §"결손 보강" 참조.

## 주차장모아 (`parking.loveash.kr`) — 상세 분석

가장 깊이 뜯어본 경쟁사. 전체 분석은 [own-content-strategy.md](../exec-plans/own-content-strategy.md) 참조.

| 항목 | 값 |
|---|---|
| sitemap | 주차장 19,271 · 장소(`/info`) 6,170 · 가이드글(`/post`) 2,474 |
| 광고 | Google AdSense **자동 광고** (`ca-pub-7742126992195898`). 수동 슬롯 없음. `ads.txt` 는 404 |
| 상세페이지 | 가시 텍스트 2,126~2,379자, **긁어온 원문 0자** |
| 강점 | 요금 문자열 하나에서 30/60/120분 표·계산기·도보분을 계산해 만든다 |
| 약점 | `/post` 2,474건이 LLM 양산물. **"제가 실제로 걸어본 동선"** 같은 1인칭 허위 서술 + 프롬프트 누출("입력 데이터에 표기된…") |
| 약점 | 요금 데이터가 비어도 발행 → `0min 0`, "1시간 예상 요금은 0원입니다" |

## 결손 보강 — 크롤이 아니라 원천으로

2026-09-02 remote 실측. 결손은 **출처에 따라 완전히 갈린다.**

| 출처 | 건수 | 면수 결손 | 전화 결손 | 운영시간 결손 | 유료·요금없음 |
|---|---:|---:|---:|---:|---:|
| 공공데이터(관리번호 id) | 12,671 | **5.0%** | 19.1% | **0.0%** | 5.3% |
| 카카오(`KA-` id) | 19,323 | **79.5%** | 82.0% | 35.1% | 32.2% |

**결손은 사실상 카카오 출처 주차장의 문제다.** 그리고 경쟁사도 같은 공공데이터를 쓰므로 이 구멍을 메워주지 못한다.

이미 있는 보강 경로의 실적:

| `verified_source` | 건수 | 면수 보유율 |
|---|---:|---:|
| `public_api` | 2,176 | **100.0%** |
| `kakao_detail` | 2,903 | 5.5% (카카오 상세에 주차면수가 없다) |
| `blog_ai` | 573 | 13.4% |
| **`(없음)` — 한 번도 보강 안 됨** | **13,641** | 11.3% |

→ `scripts/enrich-from-public-data.ts` 는 매칭만 되면 **면수를 100% 채운다.**
아직 손대지 않은 **13,641건**을 먼저 돌리는 것이 경쟁사 크롤보다 확실하고, 무료이며, 법적 부담도 없다.

## 크롤 시 유의

경쟁사 페이지를 우리 `web_sources` 에 넣는 것은 **집계 오염**이다. 이미 샘플에서 확인됐다 —
차이나타운공영주차장의 후기 14건 중 2건이 `jucha.kr` 과 `parking.worldtourlist.com` 이었다.
위 목록의 도메인은 **수집 또는 집계 단계에서 제외**한다 (detail-page-v2.md 0-1 항목).
