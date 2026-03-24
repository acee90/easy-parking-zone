-- web_sources_raw: URL 단위 크롤링 원본 저장소
-- 크롤링 → raw 저장 → AI 필터 → 주차장 매칭 → web_sources
CREATE TABLE IF NOT EXISTS web_sources_raw (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,              -- naver_blog, naver_cafe, brave_search, ddg_search, youtube, tistory_blog, poi
  source_id TEXT NOT NULL,           -- URL hash (dedup)
  source_url TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  author TEXT,
  published_at TEXT,
  crawled_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- AI 필터 결과
  filter_passed INTEGER,             -- NULL=미분류, 1=통과, 0=제거
  filter_removed_by TEXT,            -- ad, realestate, irrelevant, news, monthly, wedding
  sentiment_score REAL,
  ai_difficulty_keywords TEXT,       -- JSON 배열
  ai_summary TEXT,
  ai_filtered_at TEXT,
  -- 매칭 상태
  matched_at TEXT,                   -- NULL=미매칭, datetime=매칭 완료
  UNIQUE(source, source_id)
);

CREATE INDEX IF NOT EXISTS idx_raw_filter ON web_sources_raw(filter_passed, ai_filtered_at);
CREATE INDEX IF NOT EXISTS idx_raw_matched ON web_sources_raw(filter_passed, matched_at);
CREATE INDEX IF NOT EXISTS idx_raw_source_url ON web_sources_raw(source_url);

-- web_sources에 raw_source_id FK 추가
ALTER TABLE web_sources ADD COLUMN raw_source_id INTEGER REFERENCES web_sources_raw(id);
