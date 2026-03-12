-- POI 파이프라인에서 매칭/지오코딩 모두 실패한 주차장
CREATE TABLE IF NOT EXISTS poi_unmatched (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poi_name TEXT NOT NULL,
  lot_name TEXT NOT NULL,
  poi_lat REAL NOT NULL,
  poi_lng REAL NOT NULL,
  category TEXT,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | resolved | ignored
  resolved_lot_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_poi_unmatched_status ON poi_unmatched(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_poi_unmatched_unique ON poi_unmatched(poi_name, lot_name);
