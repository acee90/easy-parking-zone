# #166 기준 검색어 10개와 순위 기준선

- **측정일**: 2026-09-03
- **방법**: 네이버 통합검색(PC) 결과를 firecrawl로 수집해, **웹사이트 블록**에서 외부 도메인이 처음 등장하는 순서를 순위로 셌습니다. 네이버 자체 블록(AI 브리핑, 플레이스, 이미지, 블로그·카페)은 세지 않았습니다. 재측정도 같은 방법으로 합니다.
- **용도**: 구현 계획 9-3절의 "기준 검색어 10개 순위" 판정 입력값입니다. 목표치는 두지 않고 추이만 봅니다.

## 검색어 선정 이유

역 이름 + "근처 주차장" 형태입니다(기획 4-0절). 수도권 큰 역 6곳(석촌·강남·잠실·사당·신촌·판교), 수도권 외곽 1곳(수원), 지방 광역시 3곳(부산·대전·대구 반월당)을 섞어서, 서울 편중을 피했습니다. 10곳 모두 이번 평가에서 게이트를 통과해 발행 대상에 들어 있습니다.

## 기준선 (2026-09-03, 발행 전)

| 검색어 | 우리 순위 | 우리가 잡힌 URL | 1위 | 2위 | 3위 |
|---|---|---|---|---|---|
| 석촌역 근처 주차장 | 없음 | | hazelfy.com | parking.mustarddata.com | parking.worldtourlist.com |
| 강남역 근처 주차장 | 9 | /wiki/카카오-T-강남역-주차장-KA-596922358 | hazelfy.com | parking.worldtourlist.com | parkingplace.product-pack.com |
| 잠실역 근처 주차장 | 6 | /wiki/잠실역-공영주차장-KA-27216884 | hazelfy.com | parking.worldtourlist.com | parking.mustarddata.com |
| 사당역 근처 주차장 | 9 | /wiki/사당역-공영주차장-KA-23371032 | hazelfy.com | parking.worldtourlist.com | issuetale.kr |
| 수원역 근처 주차장 | 없음 | | monoalda.com | bluesquare.app | parking.worldtourlist.com |
| 신촌역 근처 주차장 | 없음 | | hazelfy.com | m.miz.co.kr | parking.mustarddata.com |
| 판교역 근처 주차장 | 8 | /wiki/판교역-환승-공영주차장-KA-20588116 | parking.worldtourlist.com | hazelfy.com | parkingplace.product-pack.com |
| 부산역 근처 주차장 | 9 | /wiki/부산역-북항주차장-KA-2134774959 | monoalda.com | busan.go.kr | ozhoper.com |
| 대전역 근처 주차장 | 없음 | | ezday.co.kr | parking.worldtourlist.com | issuetale.kr |
| 반월당역 근처 주차장 | 없음 | | parking.mustarddata.com | issuetale.kr | bluesquare.app |

**요약: 10개 중 5개에서 6~9위, 5개는 없음. 1~5위 진입은 0개.**

## 읽는 법

잡힌 5개는 전부 **역 이름을 그대로 가진 주차장의 `/wiki/` 페이지**입니다("잠실역 공영주차장", "사당역 공영주차장"). 즉 지금은 주차장 이름이 우연히 검색어와 겹칠 때만 잡히고, 그 경우에도 6위 아래입니다. 상위 1~3위는 `hazelfy.com`(/near/{역})과 `parking.mustarddata.com`(/near/{역})이 반복해서 차지합니다. 목적지 페이지 발행 뒤 재측정에서 볼 것은 두 가지입니다. `/near/` URL이 `/wiki/` URL을 대체하며 올라오는지, 없음이었던 5개에 진입하는지.

## 재측정 방법

```bash
# 검색어마다 한 번씩
firecrawl scrape "https://search.naver.com/search.naver?query=<검색어 URL 인코딩>" \
  --wait-for 3000 --format markdown,links -o serp/<역>.json
# 마크다운에서 "새 창 열림](url)" 링크의 도메인 첫 등장 순서 = 웹사이트 블록 순위
```
