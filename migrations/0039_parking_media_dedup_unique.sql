-- 중복 parking_media rows 정리 (parking_lot_id + url 기준, MIN(id) 보존)
DELETE FROM parking_media
WHERE id NOT IN (
  SELECT MIN(id) FROM parking_media GROUP BY parking_lot_id, url
);

-- 이후 중복 삽입 방지를 위한 UNIQUE INDEX
CREATE UNIQUE INDEX IF NOT EXISTS uq_parking_media_lot_url
  ON parking_media (parking_lot_id, url);
