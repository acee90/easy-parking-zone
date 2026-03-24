-- 주차장 이름/주소 FTS5 인덱스 (매칭 검색용)
CREATE VIRTUAL TABLE IF NOT EXISTS parking_lots_fts USING fts5(
  lot_id UNINDEXED,
  name,
  address
);

INSERT INTO parking_lots_fts(lot_id, name, address)
SELECT id, name, address FROM parking_lots;

-- 신규 주차장 자동 동기화 트리거
CREATE TRIGGER IF NOT EXISTS parking_lots_fts_insert
AFTER INSERT ON parking_lots
BEGIN
  INSERT INTO parking_lots_fts(lot_id, name, address)
  VALUES (NEW.id, NEW.name, NEW.address);
END;

CREATE TRIGGER IF NOT EXISTS parking_lots_fts_update
AFTER UPDATE OF name, address ON parking_lots
BEGIN
  DELETE FROM parking_lots_fts WHERE lot_id = OLD.id;
  INSERT INTO parking_lots_fts(lot_id, name, address)
  VALUES (NEW.id, NEW.name, NEW.address);
END;

CREATE TRIGGER IF NOT EXISTS parking_lots_fts_delete
AFTER DELETE ON parking_lots
BEGIN
  DELETE FROM parking_lots_fts WHERE lot_id = OLD.id;
END;
