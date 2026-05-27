-- web_sources_raw.search_lot_hint
-- 크롤러가 lot 키워드로 검색해서 적재한 raw row에 대해, 검색에 사용한 lot.id를 기록.
-- 매칭 검증 단계에서 후보 lot으로 활용. raw lot-less 원칙은 유지하되 hint만 보존.
-- 적용 대상: youtube_video (영상 description 빈약 → 본문 기반 매칭 어려움)
-- naver/ddg는 본문이 충분해서 hint 없이도 매칭 가능하나, 향후 활용 가능.

ALTER TABLE web_sources_raw ADD COLUMN search_lot_hint TEXT;
