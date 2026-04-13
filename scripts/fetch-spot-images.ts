/**
 * 관광지 이미지 검색 스크립트 (카카오 이미지 검색 API)
 *
 * Usage: bun run scripts/fetch-spot-images.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'

const KAKAO_API_KEY = process.env.KAKAO_REST_API_KEY
if (!KAKAO_API_KEY) throw new Error('KAKAO_REST_API_KEY not set in .env')

interface Spot {
  name: string
  description: string
  lat: number | null
  lng: number | null
  address?: string | null
  imageUrl?: string | null
  nearbyParking: unknown[]
}

interface Region {
  region: string
  spots: Spot[]
}

async function searchImage(query: string): Promise<string | null> {
  const url = `https://dapi.kakao.com/v2/search/image?query=${encodeURIComponent(query)}&size=3&sort=accuracy`
  const res = await fetch(url, {
    headers: { Authorization: `KakaoAK ${KAKAO_API_KEY}` },
  })

  if (!res.ok) {
    console.error(`  Kakao Image API error: ${res.status} for "${query}"`)
    return null
  }

  const data = (await res.json()) as {
    documents: { thumbnail_url: string; image_url: string; width: number; height: number }[]
  }

  // 가로 이미지 우선, 원본 URL 사용 (thumbnail_url은 해상도가 너무 낮음)
  const landscape = data.documents.find((d) => d.width >= d.height)
  return landscape?.image_url ?? data.documents[0]?.image_url ?? null
}

async function main() {
  const regions: Region[] = JSON.parse(
    readFileSync('scripts/data/halfprice-travel-spots-geocoded.json', 'utf-8'),
  )

  let found = 0
  let failed = 0

  for (const region of regions) {
    console.log(`\n=== ${region.region} (${region.spots.length} spots) ===`)

    for (const spot of region.spots) {
      const query = `${region.region} ${spot.name} 관광`
      const imageUrl = await searchImage(query)

      if (imageUrl) {
        spot.imageUrl = imageUrl
        console.log(`  ✓ ${spot.name}`)
        found++
      } else {
        spot.imageUrl = null
        console.log(`  ✗ ${spot.name} — 이미지 없음`)
        failed++
      }

      await new Promise((r) => setTimeout(r, 100))
    }
  }

  writeFileSync(
    'scripts/data/halfprice-travel-spots-geocoded.json',
    JSON.stringify(regions, null, 2),
  )
  console.log(`\n=== 완료 ===`)
  console.log(`Found: ${found}, Failed: ${failed}`)
}

main().catch(console.error)
