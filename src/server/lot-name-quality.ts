/**
 * 둘러보기 큐레이션 이름 품질 게이트 (D-4).
 *
 * 랭킹은 이름만으로 판단되는 화면이라, 주차장 이름이 아닌 행(도로 구간·출입구·대행 서비스)과
 * 이름만으로는 어디인지 알 수 없는 행(「주차장」「미추홀구 주차장」「신정1동」)을 상위에서 뺀다.
 * 데이터는 지우지 않는다 — 지도·검색·위키 상세에는 그대로 나온다.
 *
 * 규칙은 09-11 블라인드 채점(1차, 개발용)에서 나온 판정으로 좁혔다.
 * - 부분 문자열로 막으면 정상 이름이 걸린다(「홍대입구역 …」「해안도로 제1주차장」) → 「도로·입구·출구」는 끝말만
 * - 크롤러용 `isGenericName` 의 「2글자+주차장」은 「명품주차장」「새빌 주차장」 같은 고유명까지 막는다
 *   (1차 제외 표본 오탐 11/30 전부) → 일반명사 목록으로 바꿨다
 * - 「임시」는 표본 10곳이 전부 실제 공영주차장이라 막지 않는다
 */
import { getRegionForAddress } from '@/lib/parking-regions'

// 이 말만 있으면 어느 주차장인지 알 수 없다
const GENERIC_WORDS =
  '공영|공용|민영|사설|유료|무료|광장|노상|노외|부설|임시|지하|옥상|야외|기계식|자주식|국립공원|제?\\d+'
const GENERIC_NAME = new RegExp(`^(${GENERIC_WORDS})?\\s*(주차장|주차타워)$`)

const BAD_NAME_RULES: Array<[reason: string, pattern: RegExp]> = [
  ['generic', GENERIC_NAME],
  ['road', /이면도로|내\s*도로|도로변|도로$/],
  // 두 지점 사이 구간·「○○ 인근」처럼 범위로 적힌 이름
  ['segment', /~|(인근|주변|부근|뒤|앞|옆|\s외)$/],
  ['artifact', /@/],
  ['gate', /(입구|출구)쪽?(\s*\([^)]*\))?$/],
  // 「세차」만 쓰면 「연세차메디컬센터」가 걸린다 (2차 채점 오탐)
  ['service', /대행|세차장|손세차|차고지/],
  ['closed', /공사\s*중/],
  // 동·리·면·읍·도로명(+번지)만 있고 주차장이라는 말이 없다 — 「신정1동」「연암동 442-1」「상리2길」
  ['admin-only', /^[가-힣\d\s]*[동리면읍로길가]\s*[\d-]*$/],
]

// 시·군·구 이름 + (공영) 주차장뿐 — 「칠곡군공영주차장」「대전 서구 공영주차장」.
// 「출구·입구」의 「구」는 시·군·구가 아니다 (「역곡역1번출구 주차장」)
const REGION_ONLY = /^(?:\S+\s)?(\S+?(?<![입출])[시군구])\s*(?:공영|공용)?\s*주차장$/

/**
 * 큐레이션에서 뺄 이름이면 사유를, 아니면 null.
 * address 를 주면 「시·군·구명 + 주차장」은 그 이름이 자기 주소의 시·군·구일 때만 뺀다 —
 * 「청구 주차장」처럼 「○구」로 끝나는 고유명을 지역명으로 오인하지 않도록.
 */
export function lotNameIssue(name: string, address?: string | null): string | null {
  const trimmed = name.trim()
  if (trimmed.replace(/\s/g, '').length < 4) return 'generic'
  for (const [reason, pattern] of BAD_NAME_RULES) {
    if (pattern.test(trimmed)) return reason
  }
  const region = trimmed.match(REGION_ONLY)
  // 「대구」는 광역시라 「○구」 꼴이어도 시·군·구가 아니다 (「나이스파크 대구 주차장」, 2차 채점 오탐)
  if (region && region[1] !== '대구' && (!address || address.includes(region[1]))) {
    return 'region-only'
  }
  return null
}

/** 「금왕읍 공영주차장」「금왕읍공영주차장」, 「천북굴단지 주차장」「천북굴단지 공영1주차장」 → 같은 키 */
function nameKey(name: string): string {
  return name
    .replace(/[\s()·\-_]/g, '')
    .replace(/(공영|공용|노외|노상|부설)?\d*(주차장|주차타워)$/, '')
}

/** 주소 끝 두 토큰(도로명+번호 또는 동+번지). 표기가 달라도(「대구광역시」「대구」) 같은 곳이면 같다 */
function addressKey(address: string): string {
  const tokens = address.trim().split(/\s+/)
  return tokens.length >= 2 ? tokens.slice(-2).join('') : ''
}

type Curatable = { name: string; address?: string | null }

/**
 * 이름 품질 게이트 + 중복 제거 후 상위 n개 (입력 순서 유지).
 * 같은 시·도에서 이름(접미사 제거)이 같거나 주소 끝 두 토큰이 같으면 하나만 남긴다.
 * 시·도 라벨을 키에 넣어 전국 페이지에서 다른 도시 동명 lot(「한옥마을 주차장」 전주·경주)은 합치지 않는다.
 */
export function curateLots<T extends Curatable>(lots: readonly T[], n: number): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const lot of lots) {
    if (out.length >= n) break
    if (lotNameIssue(lot.name, lot.address)) continue
    const region = getRegionForAddress(lot.address)?.label ?? ''
    const keys = [`${region}|n:${nameKey(lot.name)}`]
    const addr = addressKey(lot.address ?? '')
    if (addr) keys.push(`${region}|a:${addr}`)
    if (keys.some((k) => seen.has(k))) continue
    for (const k of keys) seen.add(k)
    out.push(lot)
  }
  return out
}
