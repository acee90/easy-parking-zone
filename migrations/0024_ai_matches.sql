-- AI 매칭 결과 저장 테이블
-- web_sources 1건 → parking_lots N건 매칭
CREATE TABLE IF NOT EXISTS web_source_ai_matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  web_source_id INTEGER NOT NULL REFERENCES web_sources(id),
  parking_lot_id TEXT NOT NULL REFERENCES parking_lots(id),
  confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(web_source_id, parking_lot_id)
);

CREATE INDEX IF NOT EXISTS idx_wsam_web_source ON web_source_ai_matches(web_source_id);
CREATE INDEX IF NOT EXISTS idx_wsam_parking_lot ON web_source_ai_matches(parking_lot_id);
CREATE INDEX IF NOT EXISTS idx_wsam_confidence ON web_source_ai_matches(confidence);

-- web_sources에 full_text, filter 결과 컬럼 추가
ALTER TABLE web_sources ADD COLUMN full_text TEXT;
ALTER TABLE web_sources ADD COLUMN full_text_length INTEGER DEFAULT 0;
ALTER TABLE web_sources ADD COLUMN filter_passed INTEGER DEFAULT 0;
ALTER TABLE web_sources ADD COLUMN filter_removed_by TEXT;
