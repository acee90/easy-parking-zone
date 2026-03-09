-- cafe_signals에서 parking_lot_id를 분리하여 cafe_signal_lots 매핑 테이블로 이동
-- 시그널 원본(title, url, snippet)은 주차장 연결 없이도 보존됨

-- 1. 새 시그널 테이블 (title 기준 1 row)
CREATE TABLE cafe_signals_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL UNIQUE,
  url TEXT NOT NULL,
  snippet TEXT NOT NULL DEFAULT '',
  ai_sentiment TEXT NOT NULL DEFAULT 'neutral',
  human_score INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 2. 주차장 매핑 테이블
CREATE TABLE cafe_signal_lots (
  signal_id INTEGER NOT NULL REFERENCES cafe_signals_new(id) ON DELETE CASCADE,
  parking_lot_id TEXT NOT NULL,
  PRIMARY KEY (signal_id, parking_lot_id)
);

-- 3. 시그널 데이터 이관 (title별 1건)
INSERT INTO cafe_signals_new (title, url, snippet, ai_sentiment, human_score, created_at, updated_at)
SELECT title, MIN(url), MIN(snippet), MIN(ai_sentiment),
       MAX(human_score),
       MIN(created_at), MAX(updated_at)
FROM cafe_signals
GROUP BY title;

-- 4. 주차장 매핑 이관
INSERT OR IGNORE INTO cafe_signal_lots (signal_id, parking_lot_id)
SELECT sn.id, cs.parking_lot_id
FROM cafe_signals cs
JOIN cafe_signals_new sn ON sn.title = cs.title
GROUP BY sn.id, cs.parking_lot_id;

-- 5. 기존 테이블 교체
DROP TABLE cafe_signals;
ALTER TABLE cafe_signals_new RENAME TO cafe_signals;

-- 6. 인덱스
CREATE INDEX idx_cafe_signal_lots_parking ON cafe_signal_lots(parking_lot_id);
