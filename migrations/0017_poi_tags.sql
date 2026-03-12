-- parking_lots에 POI 태그 컬럼 추가
-- JSON 배열 형태로 저장 (예: ["서울역","용산역"])
ALTER TABLE parking_lots ADD COLUMN poi_tags TEXT;

-- POI 태그 검색용 인덱스
CREATE INDEX IF NOT EXISTS idx_parking_lots_poi_tags ON parking_lots(poi_tags);
