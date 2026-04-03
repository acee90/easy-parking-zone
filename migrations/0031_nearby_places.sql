CREATE TABLE nearby_places (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parking_lot_id TEXT NOT NULL REFERENCES parking_lots(id),
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  tip TEXT,
  mention_count INTEGER NOT NULL DEFAULT 1,
  source_blog_ids TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_nearby_places_lot ON nearby_places(parking_lot_id);
