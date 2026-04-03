-- 데이터 보강 출처 추적 컬럼
ALTER TABLE parking_lots ADD COLUMN verified_source TEXT;  -- 'public_api' | 'kakao_detail' | 'naver_detail'
ALTER TABLE parking_lots ADD COLUMN verified_at TEXT;       -- ISO datetime
