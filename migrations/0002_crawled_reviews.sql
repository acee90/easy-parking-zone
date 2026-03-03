-- 크롤링된 블로그/카페 후기 테이블
CREATE TABLE IF NOT EXISTS crawled_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parking_lot_id TEXT NOT NULL REFERENCES parking_lots(id),
  source TEXT NOT NULL,              -- 'naver_blog' | 'naver_cafe'
  source_id TEXT NOT NULL,           -- URL 해시 (dedup용)
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source_url TEXT NOT NULL,
  author TEXT,
  published_at TEXT,                 -- ISO date
  relevance_score INTEGER NOT NULL DEFAULT 0,  -- 0-100 관련도 점수
  crawled_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- dedup: 같은 출처의 같은 글은 한 번만 저장
CREATE UNIQUE INDEX IF NOT EXISTS idx_crawled_reviews_source
  ON crawled_reviews(source, source_id);

-- 주차장별 조회 성능
CREATE INDEX IF NOT EXISTS idx_crawled_reviews_lot
  ON crawled_reviews(parking_lot_id);
