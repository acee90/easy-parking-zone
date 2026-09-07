/**
 * 전국구로 겹치는 주차장 이름(모호 이름) 목록을 D1에서 생성한다.
 *
 * Usage:
 *   bun run scripts/generate-ambiguous-names.ts --remote
 *   bun run scripts/generate-ambiguous-names.ts --remote --stats   (파일 안 쓰고 분포만)
 *
 * 왜 손으로 안 적는가: `GENERIC_FACILITIES`(scoring.ts) 는 2026-09-04 김천 중앙시장
 * 사건에서 관측된 이름만 담은 allowlist 였고, 그래서 '국립공원주차장'·'호수공원 주차장'
 * 처럼 그때 안 본 이름이 전부 지역 검사를 건너뛰었다. `CITY_NAMES` 와 같은 방식으로
 * **DB 에서 뽑아 재생성 가능한 상수**로 둔다.
 *
 * 판정 기준 (둘 중 하나면 모호):
 *   er >= ER_MIN : 같은 이름코어를 가진 lot 이 **서로 다른 시·군** 에 존재
 *   cr >= CR_MIN : 그 코어를 **부분문자열로 포함하는** lot 들이 그만큼의 시·군에 분포
 *
 * 시·군 수로 세는 것이 핵심이다. lot 개수로 세면 '대천해수욕장 주차장'(보령시 12곳),
 * '미사경정공원 P6'(하남시 7곳) 처럼 **한 장소의 번호만 다른 주차장**이 모호로 잡힌다.
 * 그건 오염원이 아니다 — 글이 그 장소 얘기인 건 맞기 때문이다.
 *
 * 출력: src/server/crawlers/lib/ambiguous-names.generated.ts
 */

import { writeFileSync } from 'node:fs'
import { extractCity, extractProvince } from '../src/server/crawlers/lib/scoring'
import { d1Query } from './lib/d1'

const ER_MIN = 2
const CR_MIN = 4
/** 너무 짧은 코어(1자)는 부분일치가 폭발하므로 제외 */
const MIN_CORE_LEN = 2
/** 부분일치 조회 상한. 긴 코어는 여러 lot 이름에 두루 나타나지 않는다. */
const MAX_CORE_LEN = 12

const statsOnly = process.argv.includes('--stats')

/**
 * 이름코어 — 주차장 접미사·서수·공백을 걷어낸 알맹이.
 * `hasSpecificIdentifier` 의 제네릭 목록 제거와 달리 **어휘 지식을 안 쓴다.**
 * 무엇이 흔한 이름인지는 목록이 아니라 분포가 말해준다.
 */
export function nameCore(name: string): string {
  return name
    .toLowerCase()
    .replace(/(?:공영|민영|노외|노상|부설|유료|무료|임시|기계식)?\s*주차장\s*\d*$/, '')
    .replace(/\s*주차\s*$/, '')
    .replace(/제?\d+$/, '')
    .replace(/\s+/g, '')
    .trim()
}

/** 시·군 단위 지역키. 특별·광역시는 시·군이 없으므로 도 단위로 떨어진다. */
function regionKey(address: string): string {
  return extractCity(address) || extractProvince(address) || '?'
}

type LotRow = { name: string; address: string }

function main(): void {
  const lots = d1Query<LotRow>('SELECT name, address FROM parking_lots')
  console.log(`lot ${lots.length.toLocaleString()}곳 로드`)

  // 코어 → 그 코어가 정확히 일치하는 lot 들의 지역 집합
  const exactRegions = new Map<string, Set<string>>()
  for (const l of lots) {
    const c = nameCore(l.name)
    if (c.length < MIN_CORE_LEN) continue
    if (!exactRegions.has(c)) exactRegions.set(c, new Set())
    exactRegions.get(c)?.add(regionKey(l.address ?? ''))
  }

  // 부분일치를 코어마다 전체 lot 을 훑어 세면 O(코어 × lot) = 39K × 47K 로 못 돈다.
  // 방향을 뒤집는다: **lot 이름 하나에서 부분문자열을 뽑아 코어 집합에 조회**한다.
  // 이름 길이 L 이면 부분문자열은 L²/2 개뿐이라 47K × ~100 회 조회로 끝난다.
  //
  // ⚠️ 원본 이름이 아니라 **코어끼리** 비교한다. 원본으로 세면 '공영주차장' 안의 '영주',
  //    '공원주차장' 안의 '원주' 가 도시명으로 잡혀 cr 이 160 대로 부풀었다(실측).
  //    `mentionsToken` 이 왼쪽 경계를 막는 것과 같은 이유다.
  const containRegions = new Map<string, Set<string>>()
  for (const l of lots) {
    const n = nameCore(l.name)
    if (n.length < MIN_CORE_LEN) continue
    const r = regionKey(l.address ?? '')
    const seen = new Set<string>()
    for (let i = 0; i < n.length; i++) {
      for (let len = MIN_CORE_LEN; len <= MAX_CORE_LEN && i + len <= n.length; len++) {
        const sub = n.slice(i, i + len)
        if (seen.has(sub) || !exactRegions.has(sub)) continue
        seen.add(sub)
        if (!containRegions.has(sub)) containRegions.set(sub, new Set())
        containRegions.get(sub)?.add(r)
      }
    }
  }

  const ambiguous: string[] = []
  const detail: Array<{ core: string; er: number; cr: number }> = []
  for (const [core, regions] of exactRegions) {
    const er = regions.size
    const cr = containRegions.get(core)?.size ?? 0
    if (er >= ER_MIN || cr >= CR_MIN) {
      ambiguous.push(core)
      detail.push({ core, er, cr })
    }
  }
  ambiguous.sort()

  console.log(`전체 코어 ${exactRegions.size.toLocaleString()} → 모호 ${ambiguous.length.toLocaleString()}`)
  console.log(`  er>=${ER_MIN}: ${detail.filter((d) => d.er >= ER_MIN).length}`)
  console.log(`  cr>=${CR_MIN}만: ${detail.filter((d) => d.er < ER_MIN).length}`)

  if (statsOnly) {
    console.log('\n상위 20 (부분일치 분포 넓은 순):')
    for (const d of detail.sort((a, b) => b.cr - a.cr).slice(0, 20)) {
      console.log(`  er=${String(d.er).padStart(2)} cr=${String(d.cr).padStart(3)}  ${d.core}`)
    }
    return
  }

  const out = `/**
 * 자동 생성 파일 — 직접 수정하지 말 것.
 * 재생성: bun run scripts/generate-ambiguous-names.ts --remote
 *
 * 전국구로 겹쳐서 **이름만으로는 어느 주차장인지 특정할 수 없는** 이름코어 목록.
 * lot 개수가 아니라 **서로 다른 시·군의 수**로 판정한다 (er>=${ER_MIN} 또는 cr>=${CR_MIN}).
 * 판정 근거와 이 값을 쓰는 이유는 generate-ambiguous-names.ts 헤더 참조.
 *
 * 생성 시각: ${new Date().toISOString()}
 * lot ${lots.length} 곳 / 코어 ${exactRegions.size} 개 중 ${ambiguous.length} 개
 */

export const AMBIGUOUS_NAME_CORES: ReadonlySet<string> = new Set([
${ambiguous.map((c) => `  '${c.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}',`).join('\n')}
])
`
  const path = 'src/server/crawlers/lib/ambiguous-names.generated.ts'
  writeFileSync(path, out)
  console.log(`\n→ ${path} (${(out.length / 1024).toFixed(1)}KB)`)
}

main()
