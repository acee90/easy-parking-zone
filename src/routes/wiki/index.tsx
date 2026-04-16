import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { sql } from 'drizzle-orm'
import { ChevronRight, MapPin, Search, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { RankingSection } from '@/components/wiki/RankingSection'
import { getDb } from '@/db'
import { getDifficultyIcon } from '@/lib/geo-utils'
import { makeParkingSlug } from '@/lib/slug'
import { searchParkingLots } from '@/server/parking'
import { type ParkingLotRow, rowToParkingLot } from '@/server/transforms'
import type { ParkingLot } from '@/types/parking'

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
  }),
  component: WikiHomePage,
})

function WikiSearchBar() {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ParkingLot[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout>>()

  const doSearch = useCallback(async (q: string) => {
    const trimmed = q.trim()
    if (trimmed.length < 1) {
      setResults([])
      setOpen(false)
      return
    }
    setLoading(true)
    try {
      const lots = await searchParkingLots({ data: { query: trimmed } })
      setResults(lots)
      setOpen(lots.length > 0)
    } catch {
      setResults([])
      setOpen(false)
    } finally {
      setLoading(false)
    }
  }, [])

  const handleChange = (value: string) => {
    setQuery(value)
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => doSearch(value), 300)
  }

  const handleSelect = (lot: ParkingLot) => {
    setQuery(lot.name)
    setOpen(false)
    navigate({
      to: '/wiki/$slug',
      params: { slug: makeParkingSlug(lot.name, lot.id) },
    })
  }

  const clear = () => {
    setQuery('')
    setResults([])
    setOpen(false)
  }

  // 외부 클릭 시 드롭다운 닫기
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  return (
    <div className="max-w-2xl mx-auto px-4 pt-6 pb-2">
      <div ref={containerRef} className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
        <input
          type="text"
          value={query}
          onChange={(e) => handleChange(e.target.value)}
          onFocus={() => results.length > 0 && setOpen(true)}
          placeholder="주차장 이름 또는 주소로 검색"
          className="w-full pl-9 pr-9 py-2.5 text-sm rounded-lg border bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
        />
        {query && (
          <button
            onClick={clear}
            className="absolute right-3 top-1/2 -translate-y-1/2 p-0.5 hover:bg-gray-100 rounded-full cursor-pointer"
          >
            <X className="size-3.5 text-muted-foreground" />
          </button>
        )}

        {open && (
          <div className="absolute top-full left-0 right-0 mt-1 z-50 rounded-lg border bg-white shadow-lg overflow-hidden">
            {loading ? (
              <div className="px-3 py-4 text-sm text-muted-foreground text-center">검색 중...</div>
            ) : (
              <>
                <div className="max-h-72 overflow-y-auto divide-y">
                  {results.map((lot) => (
                    <button
                      key={lot.id}
                      onClick={() => handleSelect(lot)}
                      className="w-full text-left px-3 py-2.5 hover:bg-gray-50 transition-colors cursor-pointer"
                    >
                      <div className="flex items-center gap-2">
                        <MapPin className="size-3.5 text-blue-500 shrink-0" />
                        <span className="text-sm font-medium truncate">{lot.name}</span>
                        <span className="shrink-0 text-xs">
                          {getDifficultyIcon(lot.difficulty.score)}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground truncate pl-5.5">{lot.address}</p>
                    </button>
                  ))}
                </div>
                <div className="border-t bg-gray-50 px-3 py-1 text-[11px] text-muted-foreground text-right">
                  주차장 {results.length}건
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function WikiHomePage() {
  const { spacious, easy, popular } = Route.useLoaderData()

  return (
    <div className="min-h-screen bg-gray-50">
      <WikiSearchBar />

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
