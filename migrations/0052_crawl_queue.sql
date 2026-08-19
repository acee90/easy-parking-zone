-- 크롤 대상 선정을 인덱스 조회로 바꾸기 위한 materialized 큐.
--
-- 배경: selectPriorityLots 는 상위 N개를 고르려고 parking_lots 31,994행을 매번 스캔한다.
--   ORDER BY 1순위가 LEFT JOIN 된 parking_lot_stats.reliability 라 어떤 인덱스도 이 정렬을
--   서빙할 수 없다(인덱스 추가 + julianday 제거를 실측했으나 EXPLAIN 계획이 불변).
--   호출당 약 96k행 × 크롤러 3종 × 24회/일 ≈ 7M행/일 — 무료 한도(5M/일)를 이것만으로 초과.
--
-- 해결: (crawler, priority, next_at) 을 한 테이블에 물리화하고 복합 인덱스를 건다.
--   선정이 `WHERE crawler=? AND next_at<=now ORDER BY priority, next_at LIMIT n` 이 되어
--   인덱스 범위 조회로 끝난다 — 호출당 ~50행.
--
-- next_at 은 NULL 을 쓰지 않는다. `next_at IS NULL OR next_at<=?` 는 범위 조회를 깨므로,
-- 미크롤 lot 은 과거 시각을 넣어 "지금 즉시 대상"으로 표현한다.

CREATE TABLE IF NOT EXISTS crawl_queue (
  crawler  TEXT NOT NULL,       -- 'naver_blogs' | 'ddg' | 'youtube' | 'brave_search'
  lot_id   TEXT NOT NULL,
  priority INTEGER NOT NULL,    -- 0=none 1=structural 2=reference 3=estimated 4=기타
  next_at  TEXT NOT NULL,       -- 다음 크롤 가능 시각 (과거면 즉시 대상)
  PRIMARY KEY (crawler, lot_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_crawl_queue_pick ON crawl_queue(crawler, priority, next_at);

-- 백필: 크롤러 4종 × 전 주차장.
--   priority = 기존 ORDER BY 의 reliability CASE 와 동일
--   next_at  = 마지막 크롤 + 30일, 이력 없으면 과거값(=즉시 대상)
INSERT OR IGNORE INTO crawl_queue (crawler, lot_id, priority, next_at)
SELECT c.crawler,
       p.id,
       CASE s.reliability
         WHEN 'none' THEN 0 WHEN 'structural' THEN 1
         WHEN 'reference' THEN 2 WHEN 'estimated' THEN 3 ELSE 4 END,
       COALESCE(
         (SELECT datetime(cp.last_run_at, '+30 day')
            FROM crawl_progress cp
           WHERE cp.crawler_id = c.prefix || p.id
             AND cp.last_run_at IS NOT NULL
             AND cp.last_run_at GLOB '[0-9][0-9][0-9][0-9]-*'),
         '2000-01-01 00:00:00'
       )
  FROM parking_lots p
 CROSS JOIN (
   SELECT 'naver_blogs' AS crawler, 'naver_blogs_lot:'  AS prefix
   UNION ALL SELECT 'ddg',          'ddg_lot:'
   UNION ALL SELECT 'youtube',      'youtube_lot:'
   UNION ALL SELECT 'brave_search', 'brave_search_lot:'
 ) c
 LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id;
