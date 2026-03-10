-- 리뷰 출처 정보 (클리앙 댓글 등 외부 커뮤니티 리뷰)
ALTER TABLE reviews ADD COLUMN source_type TEXT;   -- 'clien' | 'community' | null(일반)
ALTER TABLE reviews ADD COLUMN source_url TEXT;     -- 원본 URL
