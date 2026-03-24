-- 주차장 이름/주소 FTS5 인덱스 (매칭 검색용)
CREATE VIRTUAL TABLE IF NOT EXISTS parking_lots_fts USING fts5(
  lot_id UNINDEXED,
  name,
  address
);

INSERT INTO parking_lots_fts(lot_id, name, address)
SELECT id, name, address FROM parking_lots;
