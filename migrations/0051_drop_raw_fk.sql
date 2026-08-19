-- web_sources / web_sources_missed 에서 web_sources_raw 로의 FK 제약을 제거한다.
--
-- 배경: web_sources_raw 를 "가공 전 임시 데이터"로 바꿔 처리 완료 후 삭제하려는데,
--   remote D1 은 `PRAGMA foreign_keys = 1` (강제)이고 아래 41,680행이 raw 를 참조한다:
--     web_sources.raw_source_id         21,740행
--     web_sources_missed.raw_source_id  19,940행
--   이 상태에서는 raw 행 DELETE 도, DROP TABLE 도 FK 에 막힌다.
--   (local 은 foreign_keys=0 이라 리허설에서 이 제약이 재현되지 않았다.)
--
-- 선택: raw_source_id 를 NULL 로 밀지 않고 **값은 보존하되 제약만 제거**한다.
--   매칭 이력 추적이 가능하고, 두 테이블은 21,899/19,970행으로 재작성이 가볍다.
--
-- 주의: web_source_ai_matches 가 web_sources(id) 를 참조하지만 0행이라 DROP 에 지장 없다.
--   RENAME 후 참조는 새 테이블로 정상 해소된다.

-- ── web_sources ────────────────────────────────────────────────────
CREATE TABLE web_sources_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parking_lot_id TEXT NOT NULL REFERENCES parking_lots(id),
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source_url TEXT NOT NULL,
  author TEXT,
  published_at TEXT,
  relevance_score INTEGER NOT NULL DEFAULT 0,
  crawled_at TEXT NOT NULL DEFAULT (datetime('now')),
  summary TEXT,
  is_positive INTEGER,
  sentiment_score REAL,
  ai_difficulty_keywords TEXT,
  ai_summary TEXT,
  ai_filtered_at TEXT,
  raw_source_id INTEGER,              -- FK 제거 (값은 보존)
  relevance_score_v2 INTEGER,
  filter_passed_v2 INTEGER,
  filter_v2_reason TEXT,
  filter_v2_evaluated_at TEXT,
  missed_lot_name TEXT,
  ai_summary_updated_at TEXT,
  matched_at TEXT
);

INSERT INTO web_sources_new
  SELECT id, parking_lot_id, source, source_id, title, content, source_url,
         author, published_at, relevance_score, crawled_at, summary, is_positive,
         sentiment_score, ai_difficulty_keywords, ai_summary, ai_filtered_at,
         raw_source_id, relevance_score_v2, filter_passed_v2, filter_v2_reason,
         filter_v2_evaluated_at, missed_lot_name, ai_summary_updated_at, matched_at
    FROM web_sources;

DROP TABLE web_sources;
ALTER TABLE web_sources_new RENAME TO web_sources;

CREATE UNIQUE INDEX idx_crawled_reviews_source ON web_sources(source, source_id);
CREATE INDEX idx_crawled_reviews_lot ON web_sources(parking_lot_id);
CREATE INDEX idx_ws_raw_source_id ON web_sources(raw_source_id);
CREATE INDEX idx_ws_filter_v2_passed ON web_sources(filter_passed_v2, relevance_score_v2);
CREATE INDEX idx_ws_matched_at ON web_sources(matched_at);

-- ── web_sources_missed ─────────────────────────────────────────────
CREATE TABLE web_sources_missed_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  missed_lot_name TEXT NOT NULL,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source_url TEXT NOT NULL,
  author TEXT,
  published_at TEXT,
  raw_source_id INTEGER,              -- FK 제거 (값은 보존)
  sentiment_score REAL,
  ai_difficulty_keywords TEXT,
  full_text TEXT,
  full_text_length INTEGER DEFAULT 0,
  full_text_status TEXT DEFAULT 'pending',
  full_text_fetched_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolution_status TEXT,
  resolved_parking_lot_id TEXT REFERENCES parking_lots(id),
  resolved_at TEXT
);

INSERT INTO web_sources_missed_new
  SELECT id, missed_lot_name, source, source_id, title, content, source_url,
         author, published_at, raw_source_id, sentiment_score, ai_difficulty_keywords,
         full_text, full_text_length, full_text_status, full_text_fetched_at,
         created_at, resolution_status, resolved_parking_lot_id, resolved_at
    FROM web_sources_missed;

DROP TABLE web_sources_missed;
ALTER TABLE web_sources_missed_new RENAME TO web_sources_missed;

CREATE INDEX idx_missed_lot_name ON web_sources_missed(missed_lot_name);
CREATE INDEX idx_missed_resolution_status ON web_sources_missed(resolution_status);
