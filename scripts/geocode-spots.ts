/**
 * 반값여행 관광지 geocoding + 근처 주차장 매칭 스크립트
 *
 * Usage: bun run scripts/geocode-spots.ts
 */
import Database from 'bun:sqlite'
import { readFileSync, writeFileSync } from 'node:fs'

const KAKAO_API_KEY = process.env.KAKAO_REST_API_KEY
if (!KAKAO_API_KEY) throw new Error('KAKAO_REST_API_KEY not set in .env')

const DB_PATH =
  '.wrangler/state/v3/d1/miniflare-D1DatabaseObject/30ea4f54ddacc99bacae539f83f77ac1a38c074b22e8bbfbb72d7f194bbebacb.sqlite'

interface Spot {
  name: string
  description: string
}

interface RegionData {
  region: string
  spots: Spot[]
}

interface GeocodedSpot extends Spot {
  lat: number
  lng: number
  address?: string
  nearbyParking: {
    id: number
    name: string
    address: string
    lat: number
    lng: number
    distanceM: number
    isFree: boolean
    totalSpaces: number
    finalScore: number | null
  }[]
}

interface GeocodedRegion {
  region: string
  spots: GeocodedSpot[]
}

async function kakaoKeywordSearch(
  query: string,
): Promise<{ lat: number; lng: number; address: string } | null> {
  const url = `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(query)}&size=1`
  const res = await fetch(url, {
    headers: { Authorization: `KakaoAK ${KAKAO_API_KEY}` },
  })

  if (!res.ok) {
    console.error(`  Kakao API error: ${res.status} for "${query}"`)
    return null
  }

  const data = (await res.json()) as { documents: { y: string; x: string; address_name: string }[] }
  if (data.documents.length === 0) return null

  const doc = data.documents[0]
  return {
    lat: Number.parseFloat(doc.y),
    lng: Number.parseFloat(doc.x),
    address: doc.address_name,
  }
}

function findNearbyParking(db: Database, lat: number, lng: number, radiusKm = 3, limit = 5) {
  // Bounding box approximation: 1 degree lat ≈ 111km, 1 degree lng ≈ 88km (at 35°N)
  const latDelta = radiusKm / 111
  const lngDelta = radiusKm / 88

  const rows = db
    .query(
      `
    SELECT
      p.id, p.name, p.address, p.lat, p.lng, p.is_free, p.total_spaces,
      s.final_score,
      ((p.lat - ?) * (p.lat - ?) * 111 * 111 + (p.lng - ?) * (p.lng - ?) * 88 * 88) as dist_sq
    FROM parking_lots p
    LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
    WHERE p.lat BETWEEN ? AND ?
      AND p.lng BETWEEN ? AND ?
    ORDER BY dist_sq ASC
    LIMIT ?
  `,
    )
    .all(
      lat,
      lat,
      lng,
      lng,
      lat - latDelta,
      lat + latDelta,
      lng - lngDelta,
      lng + lngDelta,
      limit,
    ) as {
    id: number
    name: string
    address: string
    lat: number
    lng: number
    is_free: number
    total_spaces: number
    final_score: number | null
    dist_sq: number
  }[]

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    address: r.address,
    lat: r.lat,
    lng: r.lng,
    distanceM: Math.round(Math.sqrt(r.dist_sq) * 1000),
    isFree: r.is_free === 1,
    totalSpaces: r.total_spaces,
    finalScore: r.final_score,
  }))
}

async function main() {
  const spots: RegionData[] = JSON.parse(
    readFileSync('scripts/data/halfprice-travel-spots.json', 'utf-8'),
  )

  const db = new Database(DB_PATH, { readonly: true })

  const results: GeocodedRegion[] = []
  let geocodedCount = 0
  let failedCount = 0

  for (const region of spots) {
    console.log(`\n=== ${region.region} (${region.spots.length} spots) ===`)
    const geocodedSpots: GeocodedSpot[] = []

    for (const spot of region.spots) {
      const query = `${region.region} ${spot.name}`
      const geo = await kakaoKeywordSearch(query)

      if (!geo) {
        console.log(`  ✗ ${spot.name} — geocoding 실패`)
        failedCount++
        continue
      }

      const nearby = findNearbyParking(db, geo.lat, geo.lng)
      console.log(
        `  ✓ ${spot.name} → ${geo.address} (${geo.lat.toFixed(4)}, ${geo.lng.toFixed(4)}) — 주차장 ${nearby.length}개`,
      )

      geocodedSpots.push({
        ...spot,
        lat: geo.lat,
        lng: geo.lng,
        address: geo.address,
        nearbyParking: nearby,
      })
      geocodedCount++

      // Rate limit: 100ms between requests
      await new Promise((r) => setTimeout(r, 100))
    }

    results.push({ region: region.region, spots: geocodedSpots })
  }

  db.close()

  writeFileSync(
    'scripts/data/halfprice-travel-spots-geocoded.json',
    JSON.stringify(results, null, 2),
  )
  console.log(`\n=== 완료 ===`)
  console.log(`Geocoded: ${geocodedCount}, Failed: ${failedCount}`)
  console.log(`Output: scripts/data/halfprice-travel-spots-geocoded.json`)
}

main().catch(console.error)
