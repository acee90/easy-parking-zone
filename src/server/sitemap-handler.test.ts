import { describe, expect, it } from 'vitest'
import { handleSitemap } from './sitemap-handler'

describe('sitemap lastmod', () => {
  it('공식 안내를 게시한 날을 데이터 수정일과 비교해 대표 상세에 표시한다', async () => {
    const db = {
      prepare: () => ({
        all: async () => ({
          results: [
            {
              id: 'KA-1935812519',
              name: '스타필드시티 위례 주차장',
              updated_at: '2026-09-18T00:00:00Z',
            },
          ],
        }),
      }),
    } as unknown as D1Database

    const xml = await (await handleSitemap('/sitemap-test.xml', db)).text()
    expect(xml).toContain('<lastmod>2026-09-30</lastmod>')
  })

  it('정적 URL마다 확인된 콘텐츠 변경일을 표시한다', async () => {
    const xml = await (await handleSitemap('/sitemap-static.xml', {} as D1Database)).text()
    expect(xml).toMatch(/\/wiki<\/loc>\s*<lastmod>2026-09-30<\/lastmod>/)
    expect(xml).toMatch(/\/wiki\/all<\/loc>\s*<lastmod>2026-09-09<\/lastmod>/)
    expect(xml).toMatch(
      /\/wiki\/region\/%EA%B2%BD%EA%B8%B0<\/loc>\s*<lastmod>2026-09-30<\/lastmod>/,
    )
  })
})
