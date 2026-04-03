/**
 * 주변 장소 AI 추출 모듈 (Anthropic Haiku)
 *
 * 블로그 텍스트에서 주차장 근처 장소(카페/맛집/공원 등)를 추출.
 * ai-filter.ts의 classifyBatch() 패턴을 따름.
 */

const HAIKU_MODEL = 'claude-haiku-4-5-20251001'
const API_URL = 'https://api.anthropic.com/v1/messages'

export type NearbyCategory =
  | 'cafe'
  | 'restaurant'
  | 'park'
  | 'tourist'
  | 'market'
  | 'hospital'
  | 'etc'

export interface NearbyPlace {
  name: string
  category: NearbyCategory
  tip: string | null
}

export interface ExtractionInput {
  parkingName: string
  blogId: number
  blogTitle: string
  blogContent: string
}

const SYSTEM_PROMPT = `주차장 근처 블로그 글에서 주변 장소를 추출하는 JSON 분류기입니다.

출력 형식 (JSON 객체만, 설명 없이):
{
  "places": [
    {"name": "장소명", "category": "cafe", "tip": "한줄 팁 또는 null"}
  ]
}

규칙:
- 블로그에서 언급된 실제 상호명/장소명만 추출 (일반 명사 X)
- category: cafe(카페/베이커리), restaurant(맛집/식당), park(공원/산책로), tourist(관광지/명소), market(시장/마트), hospital(병원/의원), etc(기타)
- tip: 블로그에서 언급한 방문 팁이 있으면 20자 이내로. 없으면 null
- 주차장 자체는 제외, 주변 장소만
- 장소가 없으면 {"places": []}
- 최대 5개까지`

/**
 * 주차장 1개의 블로그 묶음에서 주변 장소 추출
 * @returns 블로그별 추출 결과 배열
 */
export async function extractFromBlogs(
  parkingName: string,
  blogs: Array<{ id: number; title: string; content: string }>,
  apiKey: string,
): Promise<Array<{ blogId: number; places: NearbyPlace[] }>> {
  if (blogs.length === 0) return []

  const itemsText = blogs
    .map(
      (b, i) =>
        `[${i + 1}] 제목: ${b.title} | 내용: ${b.content.slice(0, 500)}`,
    )
    .join('\n\n')

  const userPrompt = `주차장 "${parkingName}" 근처 블로그 ${blogs.length}건에서 주변 장소를 추출하세요.\n\n${itemsText}`

  const systemPrompt =
    blogs.length === 1
      ? SYSTEM_PROMPT
      : `${SYSTEM_PROMPT}\n\n여러 블로그가 주어집니다. 각 블로그별로 JSON 배열로 출력하세요:\n[{"places": [...]}, {"places": [...]}, ...]`

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: HAIKU_MODEL,
      max_tokens: 300 * blogs.length,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
    signal: AbortSignal.timeout(30_000),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Haiku API ${res.status}: ${text}`)
  }

  const data = (await res.json()) as {
    content: Array<{ type: string; text: string }>
  }
  const text = data.content[0]?.text ?? ''

  if (blogs.length === 1) {
    const places = parseOnePlaces(text)
    return [{ blogId: blogs[0].id, places }]
  }
  return parseBatchPlaces(text, blogs)
}

function parseOnePlaces(text: string): NearbyPlace[] {
  try {
    const m = text.match(/\{[\s\S]*\}/)
    if (!m) return []
    const obj = JSON.parse(m[0])
    return toPlaces(obj.places)
  } catch {
    return []
  }
}

function parseBatchPlaces(
  text: string,
  blogs: Array<{ id: number; title: string; content: string }>,
): Array<{ blogId: number; places: NearbyPlace[] }> {
  try {
    const m = text.match(/\[[\s\S]*\]/)
    if (!m) return blogs.map((b) => ({ blogId: b.id, places: [] }))
    const arr = JSON.parse(m[0]) as unknown[]
    return blogs.map((b, i) => {
      const item = arr[i] as Record<string, unknown> | undefined
      return { blogId: b.id, places: toPlaces(item?.places) }
    })
  } catch {
    return blogs.map((b) => ({ blogId: b.id, places: [] }))
  }
}

const VALID_CATEGORIES = new Set([
  'cafe', 'restaurant', 'park', 'tourist', 'market', 'hospital', 'etc',
])

function toPlaces(raw: unknown): NearbyPlace[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter(
      (p): p is Record<string, unknown> =>
        typeof p === 'object' && p !== null && typeof (p as Record<string, unknown>).name === 'string',
    )
    .slice(0, 5)
    .map((p) => ({
      name: String(p.name).slice(0, 50),
      category: (VALID_CATEGORIES.has(String(p.category)) ? String(p.category) : 'etc') as NearbyCategory,
      tip: p.tip ? String(p.tip).slice(0, 50) : null,
    }))
}

/**
 * 주차장 1개의 추출 결과를 병합 (동일 장소명 중복 제거, mention_count 합산)
 */
export function mergeExtractedPlaces(
  results: Array<{ blogId: number; places: NearbyPlace[] }>,
): Array<{ name: string; category: NearbyCategory; tip: string | null; mentionCount: number; sourceBlogIds: number[] }> {
  const map = new Map<
    string,
    { category: NearbyCategory; tip: string | null; count: number; blogIds: number[] }
  >()

  for (const { blogId, places } of results) {
    for (const place of places) {
      const key = place.name.toLowerCase().replace(/\s/g, '')
      const existing = map.get(key)
      if (existing) {
        existing.count++
        if (!existing.blogIds.includes(blogId)) existing.blogIds.push(blogId)
        if (!existing.tip && place.tip) existing.tip = place.tip
      } else {
        map.set(key, {
          category: place.category,
          tip: place.tip,
          count: 1,
          blogIds: [blogId],
        })
      }
    }
  }

  return Array.from(map.entries()).map(([_, v]) => ({
    name: _.length > 0 ? results.flatMap((r) => r.places).find(
      (p) => p.name.toLowerCase().replace(/\s/g, '') === _,
    )!.name : '',
    category: v.category,
    tip: v.tip,
    mentionCount: v.count,
    sourceBlogIds: v.blogIds,
  }))
}
