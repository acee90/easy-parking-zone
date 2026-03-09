-- 개별 카페 시그널 테이블 (수동 검수용)
CREATE TABLE IF NOT EXISTS cafe_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parking_lot_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  snippet TEXT NOT NULL DEFAULT '',
  ai_sentiment TEXT NOT NULL DEFAULT 'neutral',  -- 'positive', 'negative', 'neutral'
  human_score INTEGER,  -- NULL=미검수, 0=무관, 1-5=난이도 용이성
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(parking_lot_id, url)
);

CREATE INDEX idx_cafe_signals_lot ON cafe_signals(parking_lot_id);
CREATE INDEX idx_cafe_signals_human ON cafe_signals(human_score);
