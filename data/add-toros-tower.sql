-- 토로스 주차타워 (홍대 CGV 건물 부설 주차타워)
-- 출처: 네이버 placeId 1035221419, 검색 결과 / 도로명주소 시스템 / 모두의주차장
-- 사용자 보고는 "토르소" 였으나 정식 표기 확인 결과 "토로스"
INSERT INTO parking_lots (
  id, name, type, address, lat, lng,
  total_spaces, is_free,
  base_time, base_fee, extra_time, extra_fee, daily_max, monthly_pass,
  payment_methods, notes,
  is_curated, curation_tag, curation_reason,
  verified_source, verified_at, status
) VALUES (
  'NV-1269226503_375565056',
  '토로스 주차타워',
  '노외',
  '서울특별시 마포구 동교로 180',
  37.5565056, 126.9226503,
  0, 0,
  NULL, NULL, NULL, NULL, 10000, 100000,
  NULL,
  '기계식 주차타워. 토로스쇼핑타워(홍대 CGV 건물) 부설. 평일 당일권 10,000원 · 휴일 당일권 12,000원 · 3시간권 6,000원 · 2일 연박 25,000~30,000원 · 월정기 100,000원. 홍대입구역 1번 출구 인근. 네이버 placeId: 1035221419. 지번: 마포구 동교동 161-2.',
  1,
  'hongdae',
  '홍대입구역 1번 출구 정면. 기계식이라 SUV/대형 진입 제한 가능',
  'naver_place',
  datetime('now'),
  'active'
);
