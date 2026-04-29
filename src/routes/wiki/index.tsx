import { createFileRoute, Link } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { sql } from 'drizzle-orm'
import { ChevronRight } from 'lucide-react'
import { RankingSection } from '@/components/wiki/RankingSection'
import { getDb } from '@/db'
import { type ParkingLotRow, rowToParkingLot } from '@/server/transforms'

const fetchWikiHome = createServerFn({ method: 'GET' }).handler(async () => {
  const db = getDb()

  // 넓은 주차장 TOP (주차면 수 기준)
  const spaciousRows = await db.all(
    sql.raw(
      `SELECT p.*,
        s.final_score as avg_score,
        COALESCE(s.user_review_count, 0) + COALESCE(s.community_count, 0) as review_count,
        s.reliability
      FROM parking_lots p
      LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
      WHERE p.total_spaces >= 200
      ORDER BY p.total_spaces DESC
      LIMIT 10`,
    ),
  )

  // 초보 추천 TOP
  const easyRows = await db.all(
    sql.raw(
      `SELECT p.*,
        s.final_score as avg_score,
        COALESCE(s.user_review_count, 0) + COALESCE(s.community_count, 0) as review_count,
        s.reliability
      FROM parking_lots p
      LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
      WHERE p.curation_tag = 'easy'
      ORDER BY s.final_score DESC
      LIMIT 10`,
    ),
  )

  // 웹에서 많이 언급된 주차장 (광고 제외)
  const popularRows = await db.all(
    sql.raw(
      `SELECT p.*,
        s.final_score as avg_score,
        (SELECT COUNT(*) FROM web_sources ws
         WHERE ws.parking_lot_id = p.id) as review_count,
        s.reliability
      FROM parking_lots p
      JOIN parking_lot_stats s ON s.parking_lot_id = p.id
      WHERE (SELECT COUNT(*) FROM web_sources ws
             WHERE ws.parking_lot_id = p.id) > 0
      ORDER BY review_count DESC
      LIMIT 10`,
    ),
  )

  return {
    spacious: (spaciousRows as unknown as ParkingLotRow[]).map(rowToParkingLot),
    easy: (easyRows as unknown as ParkingLotRow[]).map(rowToParkingLot),
    popular: (popularRows as unknown as ParkingLotRow[]).map(rowToParkingLot),
  }
})

export const Route = createFileRoute('/wiki/')({
  loader: () => fetchWikiHome(),
  head: () => ({
    meta: [
      { title: '주차장 둘러보기 | 쉽주' },
      {
        name: 'description',
        content: '초보 추천부터 넓은 주차장 TOP까지. 실제 데이터 기반 전국 주차장 큐레이션.',
      },
      {
        name: 'robots',
        content: 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1',
      },
      { httpEquiv: 'content-language', content: 'ko' },
      { property: 'og:title', content: '주차장 둘러보기 | 쉽주' },
      {
        property: 'og:description',
        content: '초보 추천부터 넓은 주차장 TOP까지. 실제 데이터 기반 전국 주차장 큐레이션.',
      },
      { property: 'og:type', content: 'website' },
      { property: 'og:url', content: 'https://easy-parking.xyz/wiki' },
      { property: 'og:image', content: 'https://easy-parking.xyz/og-image.png' },
      { property: 'og:site_name', content: '쉽주' },
      { name: 'twitter:card', content: 'summary_large_image' },
      { name: 'twitter:title', content: '주차장 둘러보기 | 쉽주' },
      {
        name: 'twitter:description',
        content: '초보 추천부터 넓은 주차장 TOP까지. 실제 데이터 기반 전국 주차장 큐레이션.',
      },
      { name: 'twitter:image', content: 'https://easy-parking.xyz/og-image.png' },
    ],
    links: [{ rel: 'canonical', href: 'https://easy-parking.xyz/wiki' }],
  }),
  component: WikiHomePage,
})

function WikiHomePage() {
  const { spacious, easy, popular } = Route.useLoaderData()

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto px-4 py-6 space-y-6">
        {/* 반값여행 이벤트 배너 */}
        <Link
          to="/event/halfprice-travel"
          className="block bg-gradient-to-r from-blue-50 to-indigo-50 rounded-xl border border-blue-100 p-5 hover:border-blue-300 transition-all"
        >
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="bg-blue-600 text-white px-2 py-0.5 rounded-full text-xs font-bold">
                  반값여행
                </span>
                <span className="text-xs text-muted-foreground">4~6월 · 여행비 50% 환급</span>
              </div>
              <h2 className="font-bold text-base">16개 지역 관광지 + 주차 가이드</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                관광지별 주변 주차장 안내 · 1인 최대 10만원 환급
              </p>
            </div>
            <ChevronRight className="size-5 text-blue-400 shrink-0" />
          </div>
        </Link>

        {/* 전국 랭킹 */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <RankingSection
            title="😊 초보 추천 주차장"
            description="넓고 여유로워 초보도 편한 주차장"
            lots={easy}
          />
          <RankingSection
            title="🅿️ 넓은 주차장 TOP"
            description="주차면 수 200면 이상, 여유롭게 주차"
            lots={spacious}
          />
          <RankingSection
            title="🔥 웹에서 많이 언급된 주차장"
            description="블로그/커뮤니티에서 자주 언급되는 주차장"
            lots={popular}
            className="md:col-span-2"
          />
        </div>
      </div>
    </div>
  )
}
