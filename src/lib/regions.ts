/** 반값여행 16개 지역 코드 맵 */
export const REGIONS = [
  { slug: 'hoengseong', name: '횡성', prefix: '횡성', province: '강원' },
  { slug: 'pyeongchang', name: '평창', prefix: '평창', province: '강원' },
  { slug: 'yeongwol', name: '영월', prefix: '영월', province: '강원' },
  { slug: 'jecheon', name: '제천', prefix: '제천', province: '충북' },
  { slug: 'geochang', name: '거창', prefix: '거창', province: '경남' },
  { slug: 'hapcheon', name: '합천', prefix: '합천', province: '경남' },
  { slug: 'gochang', name: '고창', prefix: '고창', province: '전북' },
  { slug: 'yeonggwang', name: '영광', prefix: '영광', province: '전남' },
  { slug: 'miryang', name: '밀양', prefix: '밀양', province: '경남' },
  { slug: 'yeongam', name: '영암', prefix: '영암', province: '전남' },
  { slug: 'gangjin', name: '강진', prefix: '강진', province: '전남' },
  { slug: 'haenam', name: '해남', prefix: '해남', province: '전남' },
  { slug: 'wando', name: '완도', prefix: '완도', province: '전남' },
  { slug: 'goheung', name: '고흥', prefix: '고흥', province: '전남' },
  { slug: 'namhae', name: '남해', prefix: '남해', province: '경남' },
  { slug: 'hadong', name: '하동', prefix: '하동', province: '경남' },
] as const

export type RegionSlug = (typeof REGIONS)[number]['slug']

export function findRegion(slug: string) {
  return REGIONS.find((r) => r.slug === slug)
}
