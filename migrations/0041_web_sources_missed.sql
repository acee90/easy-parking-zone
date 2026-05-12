-- missed lot 콘텐츠 보존용 별도 테이블
-- DB에 없는 주차장명이 감지된 web_sources_raw 레코드를 저장
CREATE TABLE IF NOT EXISTS web_sources_missed (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  missed_lot_name TEXT NOT NULL,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source_url TEXT NOT NULL,
  author TEXT,
  published_at TEXT,
  raw_source_id INTEGER REFERENCES web_sources_raw(id),
  sentiment_score REAL,
  ai_difficulty_keywords TEXT,
  full_text TEXT,
  full_text_length INTEGER DEFAULT 0,
  full_text_status TEXT DEFAULT 'pending',
  full_text_fetched_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_missed_lot_name ON web_sources_missed(missed_lot_name);
