/**
 * 주차장 종합 요약(parking_lot_stats.ai_summary)의 **근거 배분 기준**
 *
 * 요약은 이용자 후기와 블로그·커뮤니티 글을 합쳐 하나로 쓴다. 사용자에게 둘을 나눠 보여줄
 * 이유가 없기 때문이다. 다만 판단이 갈릴 때는 **직접 대본 사람의 말**이 앞선다.
 *
 * 그 우선순위를 프롬프트 문장으로만 두면 지켜지지 않는다. 실측(2026-09-03)에서
 * 실사용자 리뷰를 가진 87곳 중 최악은 **리뷰 1건 : 웹 요약 21건**이었다.
 * 21:1 로 넣어놓고 "1순위를 따르라"고 적어봐야 묻힌다. 그래서 **입력 개수로 강제한다.**
 *
 * 순수 함수. DB·네트워크 접근 없음.
 */

/** 리뷰가 없을 때 웹 요약 상한 */
export const WEB_MAX = 30

/** 리뷰 1건당 허용할 웹 요약 수 */
export const WEB_PER_REVIEW = 4

/** 리뷰가 있어도 웹 근거를 이 아래로는 깎지 않는다 (너무 적으면 요약이 부실해진다) */
export const WEB_MIN_WITH_REVIEW = 4

/**
 * 이용자 리뷰 수에 따라 웹 요약을 몇 건까지 넣을지.
 *
 * 둘 다 가진 28곳의 중앙값이 리뷰 1건 : 웹 4건이라, 배수 4·하한 4 면
 * 대부분의 주차장은 지금과 같은 양이 들어가고 극단값만 잘린다.
 */
export function webQuotaFor(reviewCount: number): number {
  if (reviewCount <= 0) return WEB_MAX
  return Math.min(WEB_MAX, Math.max(WEB_MIN_WITH_REVIEW, reviewCount * WEB_PER_REVIEW))
}

/** 이 요약이 이용자 후기를 근거로 삼았는가 — 생성 결과 검수에 쓴다 */
export function hasUserEvidence(reviewCount: number): boolean {
  return reviewCount > 0
}
