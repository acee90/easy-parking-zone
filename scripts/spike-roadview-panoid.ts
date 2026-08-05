/**
 * [Phase B spike] 로드뷰 panoId 수집 가능성 검증 — 일회성 실험 스크립트
 *
 * docs/exec-plans/roadview-panoid-full-backfill.plan.md Phase B 체크리스트 검증용.
 * 검증이 끝나면 이 파일은 제거하고 scripts/collect-roadview-panoid.ts로 승격한다.
 *
 * 검증 항목:
 *   1. Playwright 브라우저에서 Panorama 생성 + pano_status 대기가 되는가
 *   2. getPanoId() / getLocation() 결과 형태 (촬영일 포함 여부)
 *   3. 이마트 월계점(KA-20562951) 좌표 vs 선택된 로드뷰 좌표 거리
 *   4. 로드뷰 없음 / 인증 오류 / timeout 동작
 *   5. lot당 소요시간 → 전수(약 3.2만 건) 백필 시간 추정
 *
 * Usage:
 *   bun run scripts/spike-roadview-panoid.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright'

const CLIENT_ID = process.env.VITE_NAVER_MAP_CLIENT_ID ?? 'bduquac5yn'
/** Naver 지도 키는 referrer 허용목록으로 제한되므로 운영 도메인을 가장한다. */
const ORIGIN = 'https://easy-parking.xyz'
const PANO_TIMEOUT_MS = 10_000

/** 입력/출력 모두 리포 밖 임시 디렉터리를 쓴다 (산출물 커밋 방지) */
const LOTS_FILE = process.argv[2]
if (!LOTS_FILE) throw new Error('usage: bun run scripts/spike-roadview-panoid.ts <lots.json>')
const OUT_FILE = LOTS_FILE.replace(/[^/]+$/, 'spike-roadview-results.json')

interface Lot {
  id: string
  name: string
  address: string
  lat: number
  lng: number
  type: string
}

const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>roadview spike</title></head>
<body style="margin:0"><div id="pano" style="width:480px;height:320px"></div></body></html>`

/** 두 좌표 사이 거리(m) — haversine */
function distanceM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(bLat - aLat)
  const dLng = toRad(bLng - aLng)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

interface CollectResult {
  status: 'ok' | 'unavailable' | 'timeout' | 'error'
  rawStatus?: string
  panoId?: string
  lat?: number
  lng?: number
  photodate?: string
  title?: string
  locationKeys?: string[]
  locationDump?: Record<string, unknown>
  panoramaMethods?: string[]
  message?: string
  elapsedMs: number
}

/**
 * pano_status가 끝내 오지 않는 좌표 진단.
 * 모든 이벤트를 기록하고, 이벤트와 무관하게 getPanoId()가 채워지는지 폴링한다.
 *   DIAGNOSE="37.56097283,126.9770151" bun run scripts/spike-roadview-panoid.ts <lots.json>
 */
async function diagnose(coord: string) {
  const [lat, lng] = coord.split(',').map(Number)
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  page.on('console', (m) => console.log(`  [console.${m.type()}] ${m.text().slice(0, 200)}`))
  await page.route(`${ORIGIN}/**`, (route) =>
    route.fulfill({ contentType: 'text/html', body: PAGE_HTML }),
  )
  await page.goto(`${ORIGIN}/roadview-spike`)
  await page.evaluate(async (clientId) => {
    const load = (src: string) =>
      new Promise<void>((res, rej) => {
        const s = document.createElement('script')
        s.async = true
        s.src = src
        s.onload = () => res()
        s.onerror = () => rej(new Error(src))
        document.head.appendChild(s)
      })
    await load(`https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=${clientId}`)
    await load('https://oapi.map.naver.com/openapi/v3/maps-panorama.js')
  }, CLIENT_ID)

  console.log(`진단 좌표: ${lat}, ${lng}\n`)
  const report = await page.evaluate(
    async ({ lat, lng }) => {
      const maps = (window as any).naver.maps
      const events: string[] = []
      const p = new maps.Panorama(document.getElementById('pano'), {
        position: new maps.LatLng(lat, lng),
        pov: { pan: 0, tilt: 0, fov: 100 },
        visible: true,
      })
      for (const ev of ['pano_status', 'init', 'pano_changed', 'panorama_changed', 'error']) {
        maps.Event.addListener(p, ev, (a: unknown) => {
          events.push(`${ev}:${String(a)} @${Math.round(performance.now())}ms`)
        })
      }
      // 이벤트와 무관하게 상태가 채워지는지 폴링
      const polls: string[] = []
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 500))
        let panoId: unknown
        let loc: unknown
        try {
          panoId = p.getPanoId?.()
        } catch (e) {
          panoId = `throw:${(e as Error).message}`
        }
        try {
          const l = p.getLocation?.()
          loc = l ? { panoId: l.panoId, address: l.address, photodate: l.photodate } : null
        } catch (e) {
          loc = `throw:${(e as Error).message}`
        }
        polls.push(`${(i + 1) * 500}ms panoId=${JSON.stringify(panoId)} loc=${JSON.stringify(loc)}`)
        if (panoId) break
      }
      return { events, polls, panoType: (() => { try { return p.getPanoType?.() } catch { return null } })() }
    },
    { lat, lng },
  )
  console.log('이벤트:', report.events.length ? report.events : '(없음)')
  console.log('panoType:', JSON.stringify(report.panoType))
  console.log('폴링:')
  for (const line of report.polls) console.log('  ', line)
  await browser.close()
}

/**
 * Panorama 1개 재사용 시 stale 데이터 위험 검증.
 * A(로드뷰 있음) → B(로드뷰 없음)로 setPosition 했을 때
 * getPanoId()가 A의 값을 그대로 들고 있으면, 폴링 fallback이 B에 A의 panoId를 잘못 저장한다.
 */
async function diagnoseStale() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  await page.route(`${ORIGIN}/**`, (route) =>
    route.fulfill({ contentType: 'text/html', body: PAGE_HTML }),
  )
  await page.goto(`${ORIGIN}/roadview-spike`)
  await page.evaluate(async (clientId) => {
    const load = (src: string) =>
      new Promise<void>((res, rej) => {
        const s = document.createElement('script')
        s.async = true
        s.src = src
        s.onload = () => res()
        s.onerror = () => rej(new Error(src))
        document.head.appendChild(s)
      })
    await load(`https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=${clientId}`)
    await load('https://oapi.map.naver.com/openapi/v3/maps-panorama.js')
  }, CLIENT_ID)

  const out = await page.evaluate(async () => {
    const maps = (window as any).naver.maps
    const log: string[] = []
    const snapshot = (label: string, p: any) => {
      let id: unknown
      let addr: unknown
      try {
        id = p.getPanoId?.()
      } catch (e) {
        id = `throw:${(e as Error).message}`
      }
      try {
        addr = p.getLocation?.()?.address
      } catch (e) {
        addr = `throw:${(e as Error).message}`
      }
      log.push(`${label}: panoId=${JSON.stringify(id)} addr=${JSON.stringify(addr)}`)
    }
    const waitStatus = (p: any, ms: number) =>
      new Promise<string>((resolve) => {
        const t = setTimeout(() => resolve('TIMEOUT'), ms)
        const l = maps.Event.addListener(p, 'pano_status', (s: string) => {
          clearTimeout(t)
          maps.Event.removeListener(l)
          resolve(String(s))
        })
      })

    // A: 로드뷰 있는 좌표 (이마트 월계점)
    const p = new maps.Panorama(document.getElementById('pano'), {
      position: new maps.LatLng(37.6265483313738, 127.061887713472),
      pov: { pan: 0, tilt: 0, fov: 100 },
      visible: true,
    })
    log.push(`A status=${await waitStatus(p, 10000)}`)
    snapshot('A 직후', p)

    // B: 로드뷰 없는 좌표 (동해 해상)
    const statusB = waitStatus(p, 10000)
    p.setPosition(new maps.LatLng(37.5, 131.5))
    log.push(`B status=${await statusB}`)
    snapshot('B 직후(즉시)', p)
    await new Promise((r) => setTimeout(r, 2000))
    snapshot('B 2초 후', p)

    // C: 다시 로드뷰 있는 좌표 (안동시청)
    const statusC = waitStatus(p, 10000)
    p.setPosition(new maps.LatLng(36.56818304, 128.7302592))
    log.push(`C status=${await statusC}`)
    snapshot('C 직후', p)
    return log
  })
  for (const line of out) console.log(' ', line)
  await browser.close()
}

/** 정방위각(파노라마 → 주차장). 0=북, 시계방향. Naver Panorama pan과 같은 규약. */
function bearingDeg(fromLat: number, fromLng: number, toLat: number, toLng: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const φ1 = toRad(fromLat)
  const φ2 = toRad(toLat)
  const Δλ = toRad(toLng - fromLng)
  const y = Math.sin(Δλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360
}

/**
 * POV 비교: 현재 코드(pan=0, 정북 고정) vs 주차장 방향으로 pan 계산.
 *   POV_COMPARE="37.6265483313738,127.061887713472" bun run scripts/spike-roadview-panoid.ts <lots.json>
 */
async function diagnosePov(coord: string, outDir: string) {
  const [lat, lng] = coord.split(',').map(Number)
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 720, height: 420 } })
  await page.route(`${ORIGIN}/**`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0"><div id="pano" style="width:720px;height:420px"></div></body></html>`,
    }),
  )
  await page.goto(`${ORIGIN}/roadview-spike`)
  await page.evaluate(async (clientId) => {
    const load = (src: string) =>
      new Promise<void>((res, rej) => {
        const s = document.createElement('script')
        s.async = true
        s.src = src
        s.onload = () => res()
        s.onerror = () => rej(new Error(src))
        document.head.appendChild(s)
      })
    await load(`https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=${clientId}`)
    await load('https://oapi.map.naver.com/openapi/v3/maps-panorama.js')
  }, CLIENT_ID)

  const loc = (await page.evaluate(
    async ({ lat, lng }) => {
      const maps = (window as any).naver.maps
      const p = new maps.Panorama(document.getElementById('pano'), {
        position: new maps.LatLng(lat, lng),
        pov: { pan: 0, tilt: 0, fov: 100 },
        visible: true,
      })
      ;(window as any).__p = p
      const status = await new Promise<string>((resolve) => {
        const t = setTimeout(() => resolve('TIMEOUT'), 10000)
        maps.Event.addListener(p, 'pano_status', (s: string) => {
          clearTimeout(t)
          resolve(String(s))
        })
      })
      const l = p.getLocation()
      return {
        status,
        panoId: l?.panoId,
        lat: l?.coord?.lat?.(),
        lng: l?.coord?.lng?.(),
        address: l?.address,
        photodate: l?.photodate,
      }
    },
    { lat, lng },
  )) as Record<string, any>

  const pan = bearingDeg(loc.lat, loc.lng, lat, lng)
  const dist = Math.round(distanceM(loc.lat, loc.lng, lat, lng) * 10) / 10
  console.log(`주차장 좌표 : ${lat}, ${lng}`)
  console.log(`파노라마    : ${loc.lat}, ${loc.lng} (${loc.address}, ${loc.photodate})`)
  console.log(`panoId      : ${loc.panoId}`)
  console.log(`거리        : ${dist}m`)
  console.log(`주차장 방위 : ${pan.toFixed(1)}° (현재 코드는 pan=0 고정 → ${pan.toFixed(0)}° 어긋남)\n`)

  for (const [label, panValue] of [
    ['current-pan0', 0],
    ['fixed-bearing', pan],
  ] as const) {
    await page.evaluate(
      ({ panValue }) => {
        ;(window as any).__p.setPov({ pan: panValue, tilt: 0, fov: 100 })
      },
      { panValue },
    )
    await page.waitForTimeout(3500)
    const file = `${outDir}/roadview-${label}.png`
    await page.locator('#pano').screenshot({ path: file })
    console.log(`저장: ${file} (pan=${Number(panValue).toFixed(1)}°)`)
  }
  await browser.close()
}

/** 주차장 주변 파노라마 후보 탐색 — 링(반경×방위) 프로브로 유니크 panoId 수집 후 스크린샷 */
async function probeCandidates(coord: string, outDir: string) {
  const [lat, lng] = coord.split(',').map(Number)
  const RADII = [0, 25, 50, 75, 100, 150]
  const BEARINGS = [0, 45, 90, 135, 180, 225, 270, 315]

  /** 기준점에서 방위·거리만큼 이동한 좌표 */
  const offset = (b: number, d: number) => {
    const R = 6371000
    const toRad = (x: number) => (x * Math.PI) / 180
    const φ1 = toRad(lat)
    const λ1 = toRad(lng)
    const θ = toRad(b)
    const δ = d / R
    const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ))
    const λ2 =
      λ1 +
      Math.atan2(
        Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
        Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2),
      )
    return { lat: (φ2 * 180) / Math.PI, lng: (λ2 * 180) / Math.PI }
  }

  const probes: Array<{ lat: number; lng: number }> = []
  for (const r of RADII) {
    if (r === 0) {
      probes.push({ lat, lng })
      continue
    }
    for (const b of BEARINGS) probes.push(offset(b, r))
  }

  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 720, height: 420 } })
  await page.route(`${ORIGIN}/**`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0"><div id="pano" style="width:720px;height:420px"></div></body></html>`,
    }),
  )
  await page.goto(`${ORIGIN}/roadview-spike`)
  await page.evaluate(async (clientId) => {
    const load = (src: string) =>
      new Promise<void>((res, rej) => {
        const s = document.createElement('script')
        s.async = true
        s.src = src
        s.onload = () => res()
        s.onerror = () => rej(new Error(src))
        document.head.appendChild(s)
      })
    await load(`https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=${clientId}`)
    await load('https://oapi.map.naver.com/openapi/v3/maps-panorama.js')
  }, CLIENT_ID)

  console.log(`프로브 ${probes.length}개 (반경 ${RADII.join('/')}m)\n`)
  const found = new Map<string, Record<string, any>>()
  for (const p of probes) {
    const r = (await page.evaluate(async ({ lat, lng }) => {
      const maps = (window as any).naver.maps
      const w = window as any
      if (!w.__probe) {
        w.__probe = new maps.Panorama(document.getElementById('pano'), {
          position: new maps.LatLng(lat, lng),
          pov: { pan: 0, tilt: 0, fov: 100 },
          visible: true,
        })
        w.__probeReady = null
        maps.Event.addListener(w.__probe, 'pano_status', (s: string) => {
          if (w.__probeReady) w.__probeReady(String(s))
        })
      } else {
        w.__probe.setPosition(new maps.LatLng(lat, lng))
      }
      const status = await new Promise<string>((resolve) => {
        const t = setTimeout(() => resolve('TIMEOUT'), 4000)
        w.__probeReady = (s: string) => {
          clearTimeout(t)
          w.__probeReady = null
          resolve(s)
        }
      })
      // 재사용 인스턴스는 실패 시 직전 값을 유지하므로 OK일 때만 읽는다
      if (status !== 'OK') return { status }
      const l = w.__probe.getLocation()
      return {
        status,
        panoId: l?.panoId,
        lat: l?.coord?.lat?.(),
        lng: l?.coord?.lng?.(),
        title: l?.title,
        address: l?.address,
        photodate: l?.photodate,
      }
    }, p)) as Record<string, any>
    if (r.status === 'OK' && r.panoId && !found.has(r.panoId)) {
      found.set(r.panoId, {
        ...r,
        distanceM: Math.round(distanceM(lat, lng, r.lat, r.lng) * 10) / 10,
        panToLot: bearingDeg(r.lat, r.lng, lat, lng),
      })
    }
  }

  const list = [...found.values()].sort((a, b) => a.distanceM - b.distanceM)
  console.log(`유니크 파노라마 ${list.length}개\n`)
  console.log('  #  거리     방위   도로명(title)      촬영일                주소')
  list.forEach((c, i) => {
    console.log(
      `  ${String(i).padStart(2)} ${String(c.distanceM).padStart(6)}m ${c.panToLot.toFixed(0).padStart(4)}°  ` +
        `${(c.title || '(무명)').padEnd(18)} ${c.photodate ?? '-'}  ${c.address ?? ''}`,
    )
  })

  writeFileSync(`${outDir}/candidates.json`, JSON.stringify(list, null, 2))
  console.log(`\n후보 저장: ${outDir}/candidates.json`)
  if (process.env.SKIP_SHOTS) {
    await browser.close()
    return
  }

  // 후보별 스크린샷 (주차장 방향으로 pan)
  console.log('')
  for (const [i, c] of list.entries()) {
    await page.evaluate(
      async ({ panoId, pan }) => {
        const w = window as any
        const maps = w.naver.maps
        await new Promise<void>((resolve) => {
          const t = setTimeout(() => resolve(), 6000)
          w.__probeReady = () => {
            clearTimeout(t)
            w.__probeReady = null
            resolve()
          }
          w.__probe.setPanoId(panoId)
        })
        w.__probe.setPov({ pan, tilt: 0, fov: 100 })
      },
      { panoId: c.panoId, pan: c.panToLot },
    )
    await page.waitForTimeout(3000)
    const file = `${outDir}/cand-${String(i).padStart(2, '0')}-${c.distanceM}m-${(c.title || 'noname').replace(/[^\w가-힣]/g, '')}.png`
    await page.locator('#pano').screenshot({ path: file })
    console.log(`저장: ${file}`)
  }
  await browser.close()
}

/**
 * 선택 규칙 검증: 현재 방식(최근접+pan0) vs 제안 규칙(촬영일 최신 그룹 → 최근접, pan=주차장 방위)
 *   VERIFY="37.6265483313738,127.061887713472" OUT_DIR=... bun run scripts/spike-roadview-panoid.ts <lots.json>
 */
async function verifyRule(coord: string, outDir: string) {
  const [lat, lng] = coord.split(',').map(Number)
  const raw = readFileSync(`${outDir}/candidates.json`, 'utf-8')
  const candidates: Array<Record<string, any>> = JSON.parse(raw)

  // 규칙: 촬영 '날짜'로 그룹핑 → 최신 날짜 → 그 안에서 최근접
  const byDate = new Map<string, Array<Record<string, any>>>()
  for (const c of candidates) {
    const day = String(c.photodate ?? '').slice(0, 10)
    if (!byDate.has(day)) byDate.set(day, [])
    byDate.get(day)?.push(c)
  }
  const latestDay = [...byDate.keys()].sort().at(-1) as string
  const chosen = [...(byDate.get(latestDay) ?? [])].sort((a, b) => a.distanceM - b.distanceM)[0]
  const nearest = [...candidates].sort((a, b) => a.distanceM - b.distanceM)[0]

  console.log('촬영일 그룹:')
  for (const [day, arr] of [...byDate.entries()].sort()) {
    console.log(`  ${day}  ${String(arr.length).padStart(2)}개  최근접 ${Math.min(...arr.map((c) => c.distanceM))}m`)
  }
  console.log(`\n현재 방식(최근접)  : ${nearest.panoId} ${nearest.distanceM}m ${nearest.photodate}`)
  console.log(`제안 규칙(최신→최근접): ${chosen.panoId} ${chosen.distanceM}m ${chosen.photodate}`)
  console.log(`동일 여부: ${nearest.panoId === chosen.panoId ? '같음' : '다름 ✅'}\n`)

  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 720, height: 420 } })
  await page.route(`${ORIGIN}/**`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0"><div id="pano" style="width:720px;height:420px"></div></body></html>`,
    }),
  )
  await page.goto(`${ORIGIN}/roadview-spike`)
  await page.evaluate(async (clientId) => {
    const load = (src: string) =>
      new Promise<void>((res, rej) => {
        const s = document.createElement('script')
        s.async = true
        s.src = src
        s.onload = () => res()
        s.onerror = () => rej(new Error(src))
        document.head.appendChild(s)
      })
    await load(`https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=${clientId}`)
    await load('https://oapi.map.naver.com/openapi/v3/maps-panorama.js')
  }, CLIENT_ID)

  const shots: Array<[string, string, number]> = [
    ['before', nearest.panoId, 0], // 현재: 최근접 파노라마 + 정북
    ['after', chosen.panoId, bearingDeg(chosen.lat, chosen.lng, lat, lng)], // 제안: 선택 + 방위
  ]
  for (const [label, panoId, pan] of shots) {
    await page.evaluate(
      async ({ panoId, pan }) => {
        const w = window as any
        const maps = w.naver.maps
        if (!w.__v) {
          w.__v = new maps.Panorama(document.getElementById('pano'), {
            panoId,
            pov: { pan, tilt: 0, fov: 100 },
            visible: true,
          })
          await new Promise<void>((resolve) => {
            const t = setTimeout(() => resolve(), 8000)
            maps.Event.addListener(w.__v, 'pano_status', () => {
              clearTimeout(t)
              resolve()
            })
          })
        } else {
          w.__v.setPanoId(panoId)
          await new Promise((r) => setTimeout(r, 2500))
        }
        w.__v.setPov({ pan, tilt: 0, fov: 100 })
      },
      { panoId, pan },
    )
    await page.waitForTimeout(3500)
    const file = `${outDir}/verify-${label}.png`
    await page.locator('#pano').screenshot({ path: file })
    console.log(`저장: ${file} (panoId=${panoId} pan=${pan.toFixed(1)}°)`)
  }
  await browser.close()
}

/** lot당 프로브 좌표 수 */
function probesPerLot(radii: number[], bearings: number[]): number {
  return (radii.includes(0) ? 1 : 0) + radii.filter((r) => r > 0).length * bearings.length
}

/**
 * [Phase 2] 선택 규칙 배치 검증.
 * lot마다 후보를 프로브해 "현재 방식(최근접)" vs "제안 규칙(촬영일 최신그룹→최근접)"을 비교하고,
 * 결과가 다른 lot만 before/after 스크린샷을 남긴다.
 * 프로브 격자를 축소(41→19)해 전수 적용 비용도 함께 측정한다.
 *   BATCH=<lots.json> OUT_DIR=<dir> bun run scripts/spike-roadview-panoid.ts <lots.json>
 */
async function batchVerify(lotsFile: string, outDir: string) {
  const lots = JSON.parse(readFileSync(lotsFile, 'utf-8')) as Lot[]
  const RADII = [0, 30, 60, 100]
  const BEARINGS = [0, 60, 120, 180, 240, 300]

  const offsetCoord = (lat: number, lng: number, b: number, d: number) => {
    const R = 6371000
    const toRad = (x: number) => (x * Math.PI) / 180
    const φ1 = toRad(lat)
    const λ1 = toRad(lng)
    const θ = toRad(b)
    const δ = d / R
    const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ))
    const λ2 =
      λ1 +
      Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2))
    return { lat: (φ2 * 180) / Math.PI, lng: (λ2 * 180) / Math.PI }
  }

  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 720, height: 420 } })
  await page.route(`${ORIGIN}/**`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0"><div id="pano" style="width:720px;height:420px"></div></body></html>`,
    }),
  )
  await page.goto(`${ORIGIN}/roadview-spike`)
  await page.evaluate(async (clientId) => {
    const load = (src: string) =>
      new Promise<void>((res, rej) => {
        const s = document.createElement('script')
        s.async = true
        s.src = src
        s.onload = () => res()
        s.onerror = () => rej(new Error(src))
        document.head.appendChild(s)
      })
    await load(`https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=${clientId}`)
    await load('https://oapi.map.naver.com/openapi/v3/maps-panorama.js')
  }, CLIENT_ID)

  const report: Array<Record<string, unknown>> = []
  for (const lot of lots) {
    const t0 = Date.now()
    const probes: Array<{ lat: number; lng: number }> = []
    for (const r of RADII) {
      if (r === 0) probes.push({ lat: lot.lat, lng: lot.lng })
      else for (const b of BEARINGS) probes.push(offsetCoord(lot.lat, lot.lng, b, r))
    }

    const found = new Map<string, Record<string, any>>()
    for (const p of probes) {
      const r = (await page.evaluate(async ({ lat, lng }) => {
        const maps = (window as any).naver.maps
        const w = window as any
        if (!w.__b) {
          w.__b = new maps.Panorama(document.getElementById('pano'), {
            position: new maps.LatLng(lat, lng),
            pov: { pan: 0, tilt: 0, fov: 100 },
            visible: true,
          })
          w.__bReady = null
          maps.Event.addListener(w.__b, 'pano_status', (s: string) => {
            if (w.__bReady) w.__bReady(String(s))
          })
        } else {
          w.__b.setPosition(new maps.LatLng(lat, lng))
        }
        const status = await new Promise<string>((resolve) => {
          const t = setTimeout(() => resolve('TIMEOUT'), 4000)
          w.__bReady = (s: string) => {
            clearTimeout(t)
            w.__bReady = null
            resolve(s)
          }
        })
        // 재사용 인스턴스는 실패 시 직전 값을 유지하므로 OK일 때만 읽는다
        if (status !== 'OK') return { status }
        const l = w.__b.getLocation()
        return {
          status,
          panoId: l?.panoId,
          lat: l?.coord?.lat?.(),
          lng: l?.coord?.lng?.(),
          title: l?.title,
          photodate: l?.photodate,
        }
      }, p)) as Record<string, any>
      if (r.status === 'OK' && r.panoId && !found.has(r.panoId)) {
        found.set(r.panoId, {
          ...r,
          distanceM: Math.round(distanceM(lot.lat, lot.lng, r.lat, r.lng) * 10) / 10,
        })
      }
    }

    const cands = [...found.values()]
    const elapsedMs = Date.now() - t0
    if (cands.length === 0) {
      report.push({ id: lot.id, name: lot.name, candidates: 0, elapsedMs })
      console.log(`[${lot.id}] ${lot.name.slice(0, 22)} — 후보 없음 (${elapsedMs}ms)`)
      continue
    }

    const nearest = [...cands].sort((a, b) => a.distanceM - b.distanceM)[0]
    // 규칙: 촬영 '날짜' 최신 그룹 → 그중 최근접
    const byDate = new Map<string, Record<string, any>[]>()
    for (const c of cands) {
      const day = String(c.photodate ?? '').slice(0, 10)
      if (!byDate.has(day)) byDate.set(day, [])
      byDate.get(day)?.push(c)
    }
    const latestDay = [...byDate.keys()].sort().at(-1) as string
    const chosen = [...(byDate.get(latestDay) ?? [])].sort((a, b) => a.distanceM - b.distanceM)[0]
    const differs = chosen.panoId !== nearest.panoId

    report.push({
      id: lot.id,
      name: lot.name,
      candidates: cands.length,
      dateGroups: byDate.size,
      elapsedMs,
      nearest: {
        panoId: nearest.panoId,
        distanceM: nearest.distanceM,
        photodate: nearest.photodate,
      },
      chosen: { panoId: chosen.panoId, distanceM: chosen.distanceM, photodate: chosen.photodate },
      differs,
    })
    console.log(
      `[${lot.id.padEnd(14)}] ${lot.name.slice(0, 20).padEnd(22)} 후보${String(cands.length).padStart(3)} ` +
        `날짜${byDate.size} ${String(elapsedMs).padStart(5)}ms  ` +
        `최근접 ${String(nearest.distanceM).padStart(6)}m/${String(nearest.photodate).slice(0, 10)} → ` +
        `선택 ${String(chosen.distanceM).padStart(6)}m/${String(chosen.photodate).slice(0, 10)} ${differs ? '⚠️다름' : '동일'}`,
    )

    if (!differs) continue
    for (const [label, c, pan] of [
      ['before', nearest, 0],
      ['after', chosen, bearingDeg(chosen.lat, chosen.lng, lot.lat, lot.lng)],
    ] as const) {
      await page.evaluate(
        async ({ panoId, pan }) => {
          const w = window as any
          await new Promise<void>((resolve) => {
            const t = setTimeout(() => resolve(), 6000)
            w.__bReady = () => {
              clearTimeout(t)
              w.__bReady = null
              resolve()
            }
            w.__b.setPanoId(panoId)
          })
          w.__b.setPov({ pan, tilt: 0, fov: 100 })
        },
        { panoId: (c as Record<string, any>).panoId, pan },
      )
      await page.waitForTimeout(2800)
      await page.locator('#pano').screenshot({ path: `${outDir}/${lot.id}-${label}.png` })
    }
  }

  await browser.close()
  writeFileSync(`${outDir}/phase2-report.json`, JSON.stringify(report, null, 2))
  const withCands = report.filter((r) => (r.candidates as number) > 0)
  const diff = withCands.filter((r) => r.differs)
  const avgMs = Math.round(
    withCands.reduce((a, r) => a + (r.elapsedMs as number), 0) / (withCands.length || 1),
  )
  console.log('\n=== 요약 ===')
  console.log(`대상 ${report.length} / 후보 확보 ${withCands.length}`)
  console.log(`규칙이 최근접과 다른 lot: ${diff.length}건`)
  for (const d of diff) console.log(`  - ${d.name}`)
  console.log(`lot당 프로브 ${probesPerLot(RADII, BEARINGS)}회, 평균 ${avgMs}ms`)
  console.log(
    `전수 31,994곳 추정: 동시성 3 기준 약 ${((31994 * avgMs) / 3 / 3600000).toFixed(1)}시간`,
  )
}

async function main() {
  if (process.env.BATCH) {
    await batchVerify(process.env.BATCH, process.env.OUT_DIR ?? '.')
    return
  }
  if (process.env.VERIFY) {
    await verifyRule(process.env.VERIFY, process.env.OUT_DIR ?? '.')
    return
  }
  if (process.env.PROBE) {
    await probeCandidates(process.env.PROBE, process.env.OUT_DIR ?? '.')
    return
  }
  if (process.env.POV_COMPARE) {
    await diagnosePov(process.env.POV_COMPARE, process.env.OUT_DIR ?? '.')
    return
  }
  if (process.env.DIAGNOSE_STALE) {
    await diagnoseStale()
    return
  }
  if (process.env.DIAGNOSE) {
    await diagnose(process.env.DIAGNOSE)
    return
  }
  const lots: Lot[] = JSON.parse(readFileSync(LOTS_FILE, 'utf-8'))
  console.log(`대상 ${lots.length}건 · clientId=${CLIENT_ID}\n`)

  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()

  const consoleErrors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  const failedRequests: string[] = []
  page.on('requestfailed', (req) => {
    failedRequests.push(`${req.url()} — ${req.failure()?.errorText}`)
  })

  // 운영 도메인 origin을 가장해 referrer 제한을 통과시킨다.
  await page.route(`${ORIGIN}/**`, (route) =>
    route.fulfill({ contentType: 'text/html', body: PAGE_HTML }),
  )
  await page.goto(`${ORIGIN}/roadview-spike`)

  // --- SDK 로드 ---
  const sdkStart = Date.now()
  const sdkResult = await page.evaluate(async (clientId) => {
    const loadScript = (src: string) =>
      new Promise<void>((resolve, reject) => {
        const s = document.createElement('script')
        s.async = true
        s.src = src
        s.onload = () => resolve()
        s.onerror = () => reject(new Error(`load failed: ${src}`))
        document.head.appendChild(s)
      })

    try {
      await loadScript(
        `https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=${encodeURIComponent(clientId)}`,
      )
      const w = window as unknown as { naver?: { maps?: Record<string, unknown> } }
      if (!w.naver?.maps) return { ok: false, message: 'naver.maps namespace missing' }
      await loadScript('https://oapi.map.naver.com/openapi/v3/maps-panorama.js')
      return {
        ok: Boolean(w.naver?.maps?.Panorama),
        hasPanorama: Boolean(w.naver?.maps?.Panorama),
      }
    } catch (e) {
      return { ok: false, message: (e as Error).message }
    }
  }, CLIENT_ID)
  console.log(`SDK 로드: ${JSON.stringify(sdkResult)} (${Date.now() - sdkStart}ms)\n`)
  if (!sdkResult.ok) {
    console.error('SDK 로드 실패 — 콘솔 오류:', consoleErrors.slice(0, 5))
    await browser.close()
    process.exit(1)
  }

  // --- 브라우저측 수집 헬퍼 설치 (Panorama 1개 재사용) ---
  await page.evaluate((timeoutMs) => {
    const w = window as unknown as Record<string, unknown>
    const maps = (window as unknown as { naver: { maps: Record<string, any> } }).naver.maps
    const spike: Record<string, unknown> = { panorama: null, pending: null }
    w.__spike = spike

    const dumpLatLng = (v: unknown): { lat?: number; lng?: number } => {
      if (!v || typeof v !== 'object') return {}
      const o = v as Record<string, any>
      if (typeof o.lat === 'function') return { lat: o.lat(), lng: o.lng() }
      if (typeof o.y === 'number') return { lat: o.y, lng: o.x }
      return {}
    }

    // 값이 순환참조/클래스여도 안전하게 요약
    const summarize = (v: unknown): unknown => {
      if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) return v
      if (typeof v === 'function') return '[function]'
      if (typeof v === 'object') {
        const ll = dumpLatLng(v)
        if (ll.lat !== undefined) return `LatLng(${ll.lat}, ${ll.lng})`
        if (Array.isArray(v)) return `[array len=${v.length}]`
        return `{${Object.keys(v as object).slice(0, 12).join(',')}}`
      }
      return String(v)
    }

    ;(w as any).__spikeCollect = (lat: number, lng: number) =>
      new Promise((resolve) => {
        const started = performance.now()
        let settled = false
        const finish = (r: Record<string, unknown>) => {
          if (settled) return
          settled = true
          spike.pending = null
          resolve({ ...r, elapsedMs: Math.round(performance.now() - started) })
        }
        const timer = setTimeout(() => finish({ status: 'timeout' }), timeoutMs)

        spike.pending = (status: string) => {
          clearTimeout(timer)
          if (status !== 'OK') {
            finish({ status: 'unavailable', rawStatus: String(status) })
            return
          }
          try {
            const p = spike.panorama as any
            const loc = p.getLocation ? p.getLocation() : null
            const coord = dumpLatLng(loc?.coord ?? loc?.position)
            const locDump: Record<string, unknown> = {}
            if (loc) for (const k of Object.keys(loc)) locDump[k] = summarize((loc as any)[k])
            finish({
              status: 'ok',
              panoId: p.getPanoId ? p.getPanoId() : undefined,
              lat: coord.lat,
              lng: coord.lng,
              photodate: loc?.photodate ?? loc?.photoDate ?? undefined,
              title: loc?.title ?? undefined,
              locationKeys: loc ? Object.keys(loc) : [],
              locationDump: locDump,
              panoramaMethods: Object.getOwnPropertyNames(Object.getPrototypeOf(p))
                .filter((n) => n.startsWith('get'))
                .sort(),
            })
          } catch (e) {
            finish({ status: 'error', message: (e as Error).message })
          }
        }

        try {
          const position = new maps.LatLng(lat, lng)
          if (!spike.panorama) {
            const panorama = new maps.Panorama(document.getElementById('pano'), {
              position,
              pov: { pan: 0, tilt: 0, fov: 100 },
              visible: true,
            })
            spike.panorama = panorama
            // 리스너는 1회만 등록하고 pending 핸들러로 라우팅
            maps.Event.addListener(panorama, 'pano_status', (status: string) => {
              const pending = spike.pending as ((s: string) => void) | null
              if (pending) pending(status)
            })
          } else {
            ;(spike.panorama as any).setPosition(position)
          }
        } catch (e) {
          clearTimeout(timer)
          finish({ status: 'error', message: (e as Error).message })
        }
      })
  }, PANO_TIMEOUT_MS)

  // --- lot별 수집 ---
  const results: Array<Lot & CollectResult & { distanceM?: number }> = []
  for (const lot of lots) {
    const r = (await page.evaluate(
      ({ lat, lng }) => (window as any).__spikeCollect(lat, lng),
      { lat: lot.lat, lng: lot.lng },
    )) as CollectResult

    const dist =
      r.status === 'ok' && r.lat !== undefined && r.lng !== undefined
        ? Math.round(distanceM(lot.lat, lot.lng, r.lat, r.lng) * 10) / 10
        : undefined

    results.push({ ...lot, ...r, distanceM: dist })
    console.log(
      `[${r.status.padEnd(11)}] ${lot.id.padEnd(12)} ${lot.name.slice(0, 22).padEnd(24)}` +
        ` ${String(r.elapsedMs).padStart(5)}ms` +
        (r.status === 'ok'
          ? ` pano=${r.panoId} dist=${dist}m date=${r.photodate ?? '-'}`
          : r.rawStatus
            ? ` raw=${r.rawStatus}`
            : r.message
              ? ` err=${r.message}`
              : ''),
    )
  }

  // --- 첫 성공 결과의 getLocation() 형태 ---
  const firstOk = results.find((r) => r.status === 'ok')
  if (firstOk) {
    console.log('\n=== getLocation() 형태 ===')
    console.log('keys:', firstOk.locationKeys)
    console.log('dump:', JSON.stringify(firstOk.locationDump, null, 2))
    console.log('panorama getters:', firstOk.panoramaMethods?.join(', '))
  }

  // --- 로드뷰 없는 좌표 (동해 한가운데) ---
  console.log('\n=== 로드뷰 없음 케이스 (동해 해상 좌표) ===')
  const oceanStart = Date.now()
  const ocean = (await page.evaluate(() =>
    (window as any).__spikeCollect(37.5, 131.5),
  )) as CollectResult
  console.log(
    `status=${ocean.status} raw=${ocean.rawStatus ?? '-'} ${ocean.elapsedMs}ms (wall ${Date.now() - oceanStart}ms)`,
  )

  // --- 실패 후 이어서 정상 좌표가 다시 되는지 (재사용 안정성) ---
  const recover = (await page.evaluate(
    ({ lat, lng }) => (window as any).__spikeCollect(lat, lng),
    { lat: lots[0].lat, lng: lots[0].lng },
  )) as CollectResult
  console.log(
    `실패 직후 복구: status=${recover.status} pano=${recover.panoId} ${recover.elapsedMs}ms`,
  )

  await page.close()

  // --- 인증 오류 (잘못된 키) ---
  console.log('\n=== 인증 오류 케이스 (잘못된 키) ===')
  const badPage = await browser.newPage()
  const badErrors: string[] = []
  badPage.on('console', (m) => {
    if (m.type() === 'error') badErrors.push(m.text())
  })
  await badPage.route(`${ORIGIN}/**`, (route) =>
    route.fulfill({ contentType: 'text/html', body: PAGE_HTML }),
  )
  await badPage.goto(`${ORIGIN}/roadview-spike`)
  // 잘못된 키로 실제 Panorama까지 만들어본다.
  // 인증 실패가 '로드뷰 없음'과 같은 pano_status=ERROR로 오면, 배치 도중 키가 죽었을 때
  // 수만 건이 조용히 unavailable로 기록되는 사고가 난다. 구분 가능한 신호가 있는지 확인.
  const badResult = await badPage.evaluate(async () => {
    const loadScript = (src: string) =>
      new Promise<void>((resolve, reject) => {
        const s = document.createElement('script')
        s.async = true
        s.src = src
        s.onload = () => resolve()
        s.onerror = () => reject(new Error('script load failed'))
        document.head.appendChild(s)
      })
    try {
      await loadScript('https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=INVALID_KEY_TEST')
      const w = window as unknown as { naver?: { maps?: any } }
      if (!w.naver?.maps) return { scriptLoaded: true, hasMaps: false }
      await loadScript('https://oapi.map.naver.com/openapi/v3/maps-panorama.js')
      const maps = w.naver.maps
      if (!maps.Panorama) return { scriptLoaded: true, hasMaps: true, hasPanorama: false }

      // 정상 키로 성공했던 좌표(이마트 월계점)로 시도
      const status = await new Promise<string>((resolve) => {
        const timer = setTimeout(() => resolve('TIMEOUT'), 10_000)
        const p = new maps.Panorama(document.getElementById('pano'), {
          position: new maps.LatLng(37.6265483313738, 127.061887713472),
          pov: { pan: 0, tilt: 0, fov: 100 },
          visible: true,
        })
        maps.Event.addListener(p, 'pano_status', (s: string) => {
          clearTimeout(timer)
          resolve(String(s))
        })
      })
      return { scriptLoaded: true, hasMaps: true, hasPanorama: true, panoStatus: status }
    } catch (e) {
      return { scriptLoaded: false, message: (e as Error).message }
    }
  })
  console.log('결과:', JSON.stringify(badResult))
  console.log('콘솔오류:', badErrors.slice(0, 4))
  await badPage.close()
  await browser.close()

  // --- 요약 + 시간 추정 ---
  const okResults = results.filter((r) => r.status === 'ok')
  const times = results.map((r) => r.elapsedMs)
  const avg = times.reduce((a, b) => a + b, 0) / times.length
  const sorted = [...times].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]

  console.log('\n=== 요약 ===')
  console.log(`성공 ${okResults.length}/${results.length}`)
  console.log(`lot당 평균 ${Math.round(avg)}ms · 중앙값 ${median}ms · 최대 ${Math.max(...times)}ms`)
  if (okResults.length > 0) {
    const dists = okResults.map((r) => r.distanceM ?? 0)
    console.log(
      `거리 min ${Math.min(...dists)}m / 중앙 ${[...dists].sort((a, b) => a - b)[Math.floor(dists.length / 2)]}m / max ${Math.max(...dists)}m`,
    )
    const uniquePano = new Set(okResults.map((r) => r.panoId)).size
    console.log(`panoId 유니크 ${uniquePano}/${okResults.length}`)
  }

  const TOTAL_LOTS = 31994
  for (const conc of [1, 2, 4]) {
    const hours = (TOTAL_LOTS * avg) / conc / 1000 / 3600
    console.log(`전수 ${TOTAL_LOTS.toLocaleString()}건 @동시성 ${conc}: 약 ${hours.toFixed(1)}시간`)
  }

  if (consoleErrors.length) console.log('\n콘솔 오류 샘플:', consoleErrors.slice(0, 5))
  if (failedRequests.length) console.log('실패 요청 샘플:', failedRequests.slice(0, 5))

  writeFileSync(OUT_FILE, JSON.stringify(results, null, 2))
  console.log(`\n결과 저장: ${OUT_FILE}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
