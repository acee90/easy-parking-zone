-- 중복 크롤 방지용 최소 원장 seen_sources 를 만든다.
--
-- 배경: 지금 "이 글은 이미 수집했다"는 판단은 별도 코드가 아니라
--   web_sources_raw 의 UNIQUE(source, source_id) 제약이 하고 있다.
--   크롤러 4개(ddg/brave/youtube/naver_blog)가 전부 INSERT OR IGNORE 로 넣고
--   제약에 걸리면 조용히 무시되는 구조다. 중복 체크용 SELECT 는 코드에 없다.
--
--   web_sources_raw 를 "가공 전 임시 데이터"로 바꿔 처리 완료 후 삭제하면 이 기억이
--   사라져, 같은 글을 다시 크롤 → 본문 재수집 → AI 필터 재실행 하게 된다.
--   seen_sources 는 그 기억만 남긴다.
--
-- 크기: 같은 462,927행이 raw 로는 291MB, seen_sources 로는 17MB (실측).
--   WITHOUT ROWID + 복합 PK 라 별도 인덱스가 없다.

CREATE TABLE IF NOT EXISTS seen_sources (
  source    TEXT NOT NULL,
  source_id TEXT NOT NULL,
  PRIMARY KEY (source, source_id)
) WITHOUT ROWID;

-- 기존 raw 전량을 "이미 본 것"으로 등록
INSERT OR IGNORE INTO seen_sources (source, source_id)
  SELECT source, source_id FROM web_sources_raw;
