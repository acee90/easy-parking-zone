-- 파이프라인 단계별 일일 카운터.
--
-- 배경: 크론 6단계가 종결 raw 를 지우기 시작하면서(2026-09-04) "어제 몇 건 들어왔나"를
--   셀 근거가 사라졌다. web_sources 에는 **살아남은 것만** 남고, 탈락·실패 행은 지워진다.
--   Cloudflare Workers Logs 에 요약 줄이 남지만 보존 기간이 짧고 집계 대상이 아니다.
--
-- 왜 key-value 모양인가: 지표가 늘 때마다 마이그레이션을 쓰지 않기 위해서다.
--   컬럼으로 잡으면 "매칭 실패 사유별" 같은 걸 넣을 때마다 ALTER 가 필요하다.
--
-- 크기: 지표 약 15종 × 365일 = 연 5,500행. WITHOUT ROWID 로 인덱스도 PK 하나뿐이다.
--
-- day 는 **UTC 기준**이다. 크론이 UTC 로 돌고 D1 datetime('now') 도 UTC 라
-- KST 로 바꾸면 크론 회차와 날짜 경계가 어긋난다.

CREATE TABLE IF NOT EXISTS pipeline_daily_stats (
  day    TEXT NOT NULL,           -- 'YYYY-MM-DD' (UTC)
  metric TEXT NOT NULL,           -- 'crawl:naver_blog', 'fulltext:ok', 'filter:pass' ...
  count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, metric)
) WITHOUT ROWID;
