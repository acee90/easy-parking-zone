/**
 * 시/도 없이 저장된 MODU 주소를 역지오코딩으로 다시 채운다.
 *
 * sync-modu.ts의 reverseGeocode가 area1(시/도)과 area2(구/군)를 **둘 다** 요구해서,
 * area2가 없는 세종특별자치시 주소가 "한누리대로 2270"처럼 도로명부터 시작했다.
 * 함수는 고쳤고(있는 것만 이어붙임), 이 스크립트는 이미 들어간 행을 복구한다.
 *
 * 사용법:
 *   bun run scripts/fix-modu-address.ts --db PATH --emit-sql=DIR   # 스냅샷 수정 + UPDATE SQL 산출
 *   bun run scripts/fix-modu-address.ts --remote                    # 리모트 직접
 *
 * 환경변수: NAVER_MAP_CLIENT_ID, NAVER_MAP_CLIENT_SECRET
 */
import { mkdirSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { d1Execute, d1Query, isRemote } from './lib/d1'
import { sqlVal } from './lib/sql-flush'

const EMIT_SQL_DIR = process.argv.find((a) => a.startsWith('--emit-sql='))?.split('=')[1] ?? null
const DELAY_MS = 120

const NCP_CLIENT_ID = process.env.NAVER_MAP_CLIENT_ID
const NCP_CLIENT_SECRET = process.env.NAVER_MAP_CLIENT_SECRET
if (!NCP_CLIENT_ID || !NCP_CLIENT_SECRET) {
  console.error('❌ NAVER_MAP_CLIENT_ID / NAVER_MAP_CLIENT_SECRET 환경변수가 필요합니다.')
  process.exit(1)
}

/** 정상 주소는 시/도 이름으로 시작한다 */
const SIDO =
  /^(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충청|충북|충남|전라|전북|전남|경상|경북|경남|제주)/

async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  const url = `https://maps.apigw.ntruss.com/map-reversegeocode/v2/gc?coords=${lng},${lat}&output=json&orders=roadaddr,addr`
  const res = await fetch(url, {
    headers: {
      'x-ncp-apigw-api-key-id': NCP_CLIENT_ID as string,
      'x-ncp-apigw-api-key': NCP_CLIENT_SECRET as string,
    },
  })
  if (!res.ok) return null
  const json = (await res.json()) as {
    results?: {
      name?: string
      land?: { name?: string; number1?: string; number2?: string }
      region?: { area1?: { name?: string }; area2?: { name?: string }; area3?: { name?: string } }
    }[]
  }
  const region = json.results?.[0]
  if (!region) return null

  const land = region.land
  const area = [region.region?.area1?.name, region.region?.area2?.name, region.region?.area3?.name]
    .filter(Boolean)
    .join(' ')
    .trim()

  if (region.name === 'roadaddr' && land) {
    const roadName = land.name ?? ''
    const buildingNo = [land.number1, land.number2].filter(Boolean).join('-')
    return `${area} ${roadName} ${buildingNo}`.replace(/\s+/g, ' ').trim()
  }
  if (land) {
    const jibun = [land.number1, land.number2].filter(Boolean).join('-')
    return `${area} ${jibun}`.replace(/\s+/g, ' ').trim()
  }
  return area || null
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const all = d1Query<{ id: string; name: string; address: string; lat: number; lng: number }>(
  "SELECT id, name, address, lat, lng FROM parking_lots WHERE id LIKE 'MODU-%'",
)
const broken = all.filter((r) => !SIDO.test(r.address))
console.log(
  `MODU ${all.length.toLocaleString()}건 중 시/도로 시작하지 않는 주소: ${broken.length}건`,
)
if (broken.length === 0) {
  console.log('✅ 고칠 것 없음.')
  process.exit(0)
}

const updates: string[] = []
let failed = 0
let unchanged = 0
for (let i = 0; i < broken.length; i++) {
  const row = broken[i]
  const address = await reverseGeocode(row.lat, row.lng)
  if (!address || !SIDO.test(address)) {
    failed++
  } else if (address === row.address) {
    unchanged++
  } else {
    updates.push(
      `UPDATE parking_lots SET address = ${sqlVal(address)}, updated_at = datetime('now') WHERE id = ${sqlVal(row.id)};`,
    )
  }
  process.stdout.write(`\r  ${i + 1}/${broken.length} (수정 ${updates.length} / 실패 ${failed})`)
  await sleep(DELAY_MS)
}
console.log(`\n\n수정 ${updates.length}건, 변화없음 ${unchanged}건, 실패 ${failed}건`)

if (updates.length === 0) process.exit(0)

const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
if (EMIT_SQL_DIR) {
  mkdirSync(EMIT_SQL_DIR, { recursive: true })
  const p = resolve(EMIT_SQL_DIR, `modu-address-fix-${stamp}.sql`)
  writeFileSync(p, `-- MODU 주소 시/도 누락 복구 (${stamp})\n${updates.join('\n')}\n`)
  console.log(`📄 ${p}`)
}
if (!EMIT_SQL_DIR || !isRemote) {
  for (const u of updates) d1Execute(u)
  console.log(`✅ ${isRemote ? '리모트' : '로컬'} DB 적용 완료`)
}
