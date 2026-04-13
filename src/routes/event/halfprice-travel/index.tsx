import { createFileRoute, Link } from '@tanstack/react-router'
import { ChevronRight, ExternalLink, MapPin } from 'lucide-react'
import { REGIONS } from '@/lib/regions'
import { fetchGuideList } from '@/server/parking'

export const Route = createFileRoute('/event/halfprice-travel/')({
  loader: () => fetchGuideList(),
  head: () => ({
    meta: [
      { title: '반값여행 주차 가이드 — 16개 지역 관광지 + 주차 안내 | 쉬운주차장' },
      {
        name: 'description',
        content:
          '2026 대한민국 반값여행 16개 지역 관광지와 주변 주차장 정보. 여행경비 50% 환급받고 주차 걱정 없이 여행하세요.',
      },
      { property: 'og:title', content: '반값여행 주차 가이드 | 쉬운주차장' },
      { property: 'og:url', content: 'https://easy-parking.xyz/event/halfprice-travel' },
    ],
  }),
  component: HalfPriceTravelPage,
})

function HalfPriceTravelPage() {
  const regions = Route.useLoaderData()

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
        {/* 정책 안내 */}
        <section className="bg-gradient-to-br from-blue-50 via-indigo-50 to-violet-50 rounded-xl border border-blue-100 p-5">
          <div className="flex items-center gap-2 mb-2">
            <span className="bg-blue-600 text-white px-2.5 py-0.5 rounded-full text-xs font-bold">
              반값여행
            </span>
            <span className="text-xs text-muted-foreground">2026 상반기 · 4~6월</span>
          </div>
          <h1 className="text-xl font-bold mb-2">대한민국 반값여행 주차 가이드</h1>
          <p className="text-sm text-muted-foreground leading-relaxed">
            여행경비의 <strong className="text-foreground">50%를 환급</strong>받는 정부 지원
            사업입니다. 16개 지역을 여행하고 증빙을 제출하면 1인 최대 10만원(2인+ 최대 20만원)을
            지역사랑상품권으로 돌려받습니다.
          </p>
          <div className="flex items-center gap-3 mt-3">
            <a
              href="https://korean.visitkorea.or.kr/dgtourcard/tour50.do"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-600 hover:text-blue-800 transition-colors"
            >
              공식 신청 페이지
              <ExternalLink className="size-3" />
            </a>
            <span className="text-xs text-muted-foreground">· 18세 이상 누구나 신청 가능</span>
          </div>
        </section>

        {/* 지역 카드 그리드 */}
        <section>
          <h2 className="font-semibold text-sm mb-3">참여 지역 (16곳)</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {regions.map((region) => {
              const freeRate =
                region.total > 0 ? Math.round((region.freeCount / region.total) * 100) : 0
              return (
                <Link
                  key={region.slug}
                  to="/event/halfprice-travel/$slug"
                  params={{ slug: region.slug }}
                  className="bg-white rounded-xl border p-4 hover:border-blue-300 hover:shadow-sm transition-all"
                >
                  <div className="flex items-center gap-1.5 mb-2">
                    <MapPin className="size-3.5 text-blue-500" />
                    <span className="font-semibold text-sm">{region.name}</span>
                    <span className="text-[11px] text-muted-foreground">{region.province}</span>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>주차장 {region.total}개</span>
                    <span className="text-green-600">무료 {freeRate}%</span>
                  </div>
                </Link>
              )
            })}
          </div>
        </section>

        {/* 하단 안내 */}
        <p className="text-xs text-muted-foreground text-center">
          주차장 정보는 공공데이터 기반이며, 실제와 다를 수 있습니다.
        </p>
      </div>
    </div>
  )
}
