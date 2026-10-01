import { createFileRoute, Link, redirect } from '@tanstack/react-router'
import { ArrowRight, Compass, MapPinned } from 'lucide-react'
import { VerifiedGuideLinks } from '@/components/wiki/VerifiedGuideLinks'
import { PARKING_REGIONS } from '@/lib/parking-regions'

export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>) => ({
    lotId: typeof search.lotId === 'string' ? search.lotId : undefined,
    near:
      typeof search.near === 'string' && /^D-\d{1,8}$/.test(search.near) ? search.near : undefined,
  }),
  beforeLoad: ({ search }) => {
    if (search.lotId || search.near) {
      throw redirect({
        to: '/map',
        search: { lotId: search.lotId, near: search.near },
        statusCode: 301,
      })
    }
  },
  head: () => ({
    links: [{ rel: 'canonical', href: 'https://easy-parking.xyz/' }],
  }),
  component: HomePage,
})

function HomePage() {
  return (
    <main className="min-h-screen bg-zinc-100">
      <div className="mx-auto max-w-6xl space-y-5 px-4 py-6 md:space-y-6 md:py-10">
        <section className="rounded-[10px] bg-white px-5 py-8 md:px-10 md:py-12">
          <p className="text-sm font-semibold text-primary">출발 전 주차를 한 번 더 확인하세요</p>
          <h1 className="mt-3 max-w-3xl text-3xl font-bold leading-tight tracking-tight text-ink md:text-5xl">
            처음 가는 곳도, 주차는 쉽게.
          </h1>
          <p className="mt-4 max-w-2xl text-base leading-7 text-ink-2">
            쉬운주차장은 전국 주차장의 위치, 요금과 운영시간, 주차 난이도를 살펴보고 목적지에 맞는
            주차장을 찾는 서비스입니다. 주차장별 정보와 후기를 비교하고, 방문 전에는 최신 요금과
            운영 여부를 다시 확인하세요.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Link
              to="/map"
              search={{ lotId: undefined, near: undefined }}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-3 text-sm font-semibold text-white hover:bg-primary/90"
            >
              <MapPinned className="size-4" />
              지도에서 주변 주차장 찾기
            </Link>
            <Link
              to="/wiki"
              className="inline-flex items-center gap-2 rounded-md border border-zinc-200 bg-white px-5 py-3 text-sm font-semibold text-ink hover:bg-zinc-50"
            >
              <Compass className="size-4" />
              주차장 둘러보기
            </Link>
          </div>
        </section>

        <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <section aria-labelledby="find-title" className="rounded-[10px] bg-white px-5 py-6">
            <h2 id="find-title" className="text-xl font-bold text-ink">
              어디에 주차하시나요?
            </h2>
            <p className="mt-2 text-sm leading-6 text-ink-2">
              지역별 주차장 정보를 살펴보거나 전체 목록에서 방문할 곳을 찾아보세요.
            </p>
            <nav aria-label="지역별 주차장" className="mt-4 flex flex-wrap gap-2">
              {PARKING_REGIONS.map((region) => (
                <Link
                  key={region.label}
                  to="/wiki/region/$region"
                  params={{ region: region.label }}
                  className="rounded-md border border-zinc-200 px-3 py-2 text-sm font-medium text-ink hover:border-primary hover:text-primary"
                >
                  {region.label} 주차장
                </Link>
              ))}
            </nav>
            <a
              href="/wiki/all"
              className="mt-5 inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline"
            >
              전체 주차장 목록 <ArrowRight className="size-4" />
            </a>
          </section>

          <VerifiedGuideLinks />
        </div>

        <section className="rounded-[10px] bg-white px-5 py-6" aria-labelledby="how-title">
          <h2 id="how-title" className="text-xl font-bold text-ink">
            쉬운주차장에서 확인할 수 있는 것
          </h2>
          <div className="mt-4 grid gap-4 text-sm leading-6 text-ink-2 md:grid-cols-3">
            <p>지도에서 주변 주차장의 위치를 찾고 후보를 비교할 수 있습니다.</p>
            <p>주차장 페이지에서 요금, 운영시간, 진입 정보와 이용 후기를 확인할 수 있습니다.</p>
            <p>공식 안내를 확인한 주차장은 할인 조건과 방문 전 유의사항을 따로 정리합니다.</p>
          </div>
        </section>
      </div>
    </main>
  )
}
