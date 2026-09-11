/**
 * 둘러보기 큐레이션 이름 품질 게이트 (D-4).
 *
 * 랭킹은 이름만으로 판단되는 화면이라, 주차장 이름이 아닌 행(도로 구간·출입구·대행 서비스)과
 * 이름만으로는 어디인지 알 수 없는 행(「주차장」「미추홀구 주차장」)을 상위에서 뺀다.
 * 데이터는 지우지 않는다 — 지도·검색·위키 상세에는 그대로 나온다.
 *
 * 부분 문자열로 막으면 정상 이름이 걸린다 (09-11 표본: 「홍대입구역 …」「백수해안도로 제1주차장」).
 * 그래서 「도로·입구·출구」는 이름 끝에 올 때만 막는다. 「임시」는 표본 10곳이 전부 실제
 * 공영주차장이라 막지 않는다.
 */
import { isGenericName } from './crawlers/lib/scoring'

const BAD_NAME_RULES: Array<[reason: string, pattern: RegExp]> = [
  ['road', /이면도로|내\s*도로|도로$/],
  ['gate', /(입구|출구)쪽?(\s*\([^)]*\))?$/],
  ['service', /대행|세차/],
  ['closed', /공사\s*중/],
  // 시·군·구 이름 + 주차장뿐 — 주소와 무관한 지역명이라 어디인지 알 수 없다.
  // 「출구·입구」의 「구」는 시·군·구가 아니다 (「역곡역1번출구 주차장」)
  ['region-only', /^\S+(?<![입출])[시군구]\s*주차장$/],
]

/** 큐레이션에서 뺄 이름이면 사유를, 아니면 null */
export function lotNameIssue(name: string): string | null {
  const trimmed = name.trim()
  if (trimmed.replace(/\s/g, '').length < 4 || isGenericName(trimmed)) return 'generic'
  for (const [reason, pattern] of BAD_NAME_RULES) {
    if (pattern.test(trimmed)) return reason
  }
  return null
}

/** 같은 시·도의 같은 이름은 하나만 — 전국 페이지에서 다른 도시 동명 주차장까지 합치지 않도록 */
function dedupeKey(lot: { name: string; address?: string | null }): string {
  const name = lot.name.replace(/[\s()·\-_]/g, '')
  return `${(lot.address ?? '').trim().slice(0, 2)}|${name}`
}

/** 이름 품질 게이트 + 동명 중복 제거 후 상위 n개 (입력 순서 유지) */
export function curateLots<T extends { name: string; address?: string | null }>(
  lots: readonly T[],
  n: number,
): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const lot of lots) {
    if (out.length >= n) break
    if (lotNameIssue(lot.name)) continue
    const key = dedupeKey(lot)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(lot)
  }
  return out
}
