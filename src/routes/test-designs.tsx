import { createFileRoute, redirect } from '@tanstack/react-router'
import { ChevronRight, MapPinPen, Star } from 'lucide-react'
import { getDifficultyColor } from '@/lib/geo-utils'

export const Route = createFileRoute('/test-designs')({
  beforeLoad: () => {
    if (!import.meta.env.DEV) {
      throw redirect({ to: '/' })
    }
  },
  component: TestDesignsPage,
})

const mockLot = {
  name: '스타필드시티 명지주차장',
  address: '부산 강서구 명지국제6로 168',
  difficulty: { score: 3.3 },
  totalSpaces: 200,
  pricing: { isFree: true },
  curationReason: '부산 신축, 넓은 평면 주차장',
  totalSources: 32,
}

export function TestDesignsPage() {
  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="mx-auto max-w-4xl space-y-12">
        <div>
          <h1 className="text-3xl font-bold mb-2">디자인 후보군 (Test Page)</h1>
          <p className="text-muted-foreground">
            카드 디자인 남발을 줄이기 위한 여러 스타일 제안입니다.
          </p>
        </div>

        {/* 0-A. Current Ranking Card */}
        <section>
          <h2 className="text-xl font-bold mb-4">
            0-A. 현재 위키 페이지 캐로셀 카드 (Current Ranking Card)
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {[1, 2].map((i) => (
              <div
                key={i}
                className="flex h-full w-full flex-col gap-3 rounded-xl border bg-white p-5 shadow-xs transition-colors hover:border-blue-300 cursor-pointer"
              >
                <div className="flex items-center gap-2">
                  <div
                    className={`size-3 shrink-0 rounded-full ${getDifficultyColor(mockLot.difficulty.score)}`}
                  />
                  <h3 className="line-clamp-1 text-lg font-bold">{mockLot.name}</h3>
                </div>
                <p className="line-clamp-1 text-sm text-muted-foreground">{mockLot.address}</p>

                <p className="line-clamp-2 rounded-lg bg-blue-50 px-3 py-2 text-sm font-medium text-blue-700">
                  {mockLot.curationReason}
                </p>

                <div className="mt-auto flex items-end justify-between pt-2">
                  <div className="flex flex-wrap gap-2 text-xs">
                    <span className="rounded-full bg-gray-100 px-2.5 py-1 text-gray-700">
                      {mockLot.totalSpaces}면
                    </span>
                    <span className="rounded-full bg-gray-100 px-2.5 py-1 text-gray-700">무료</span>
                  </div>
                  <div className="flex shrink-0 items-center gap-3 text-base font-bold text-zinc-900">
                    <span className="flex items-center gap-1.5">
                      <Star className="size-4 shrink-0 fill-yellow-400 text-yellow-400" />
                      <span className="tabular-nums">{mockLot.difficulty.score.toFixed(1)}</span>
                    </span>
                    <span className="flex items-center gap-1.5">
                      <MapPinPen className="size-4 shrink-0 text-muted-foreground" />
                      <span className="tabular-nums text-muted-foreground">
                        {mockLot.totalSources}
                      </span>
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* 0-B. Current Region List */}
        <section>
          <h2 className="text-xl font-bold mb-4">
            0-B. 현재 위키 페이지 지역 리스트 (Current Region List)
          </h2>
          <div className="divide-y rounded-xl border bg-white overflow-hidden shadow-xs">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="flex items-center gap-2 px-4 py-3.5 text-base transition-colors hover:bg-gray-50 cursor-pointer"
              >
                <span className="min-w-0 flex-1 truncate font-medium">{mockLot.name}</span>
                <div className="flex shrink-0 items-center gap-3 text-sm font-semibold text-muted-foreground">
                  <span className="flex w-12 items-center gap-1.5">
                    <Star className="size-3.5 shrink-0 fill-yellow-400 text-yellow-400" />
                    <span className="tabular-nums">{mockLot.difficulty.score.toFixed(1)}</span>
                  </span>
                  <span className="flex w-10 items-center gap-1.5 font-medium">
                    <MapPinPen className="size-3.5 shrink-0" />
                    <span className="tabular-nums">{mockLot.totalSources}</span>
                  </span>
                </div>
                <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
              </div>
            ))}
          </div>
        </section>

        {/* 1. Minimal List Style */}
        <section>
          <h2 className="text-xl font-bold mb-4">1. 미니멀 리스트 (Minimal List)</h2>
          <p className="text-sm text-muted-foreground mb-4">
            테두리를 없애고 선(Divider)으로만 구분하여 여백을 넉넉히 주는 방식입니다. 가장 정돈되고
            텍스트에 집중할 수 있습니다.
          </p>
          <div className="bg-white rounded-xl shadow-xs overflow-hidden">
            <div className="divide-y">
              {[1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="flex flex-col gap-2 px-6 py-5 hover:bg-gray-50 transition-colors cursor-pointer group"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div
                        className={`size-2.5 shrink-0 rounded-full ${getDifficultyColor(mockLot.difficulty.score)}`}
                      />
                      <h3 className="text-lg font-bold group-hover:text-blue-600 transition-colors">
                        {mockLot.name}
                      </h3>
                    </div>
                    <ChevronRight className="size-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                  </div>
                  <p className="text-sm text-muted-foreground pl-5.5">{mockLot.address}</p>
                  <p className="text-sm font-medium text-blue-700 pl-5.5 mt-1">
                    {mockLot.curationReason}
                  </p>

                  <div className="flex items-center gap-4 pl-5.5 mt-3">
                    <div className="flex items-center gap-1.5 text-sm font-bold text-zinc-900">
                      <Star className="size-4 fill-yellow-400 text-yellow-400" />
                      {mockLot.difficulty.score.toFixed(1)}
                    </div>
                    <div className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
                      <MapPinPen className="size-4" />
                      {mockLot.totalSources}
                    </div>
                    <div className="ml-auto flex gap-2 text-xs">
                      <span className="bg-gray-100 px-2 py-1 rounded text-gray-700">
                        {mockLot.totalSpaces}면
                      </span>
                      <span className="bg-gray-100 px-2 py-1 rounded text-gray-700">무료</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* 2-A. Soft Tile (White / Subtle Border) */}
        <section>
          <h2 className="text-xl font-bold mb-4">2-A. 소프트 타일 (화이트 + 미세 테두리)</h2>
          <p className="text-sm text-muted-foreground mb-4">
            배경을 완전히 하얗게 두고, 눈에 잘 띄지 않는 아주 연한 테두리로만 영역을 감쌉니다.
            여백을 넓게 주어 개방감을 극대화했습니다.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {[1, 2].map((i) => (
              <div
                key={i}
                className="flex flex-col gap-4 rounded-3xl border border-gray-100 bg-white p-6 hover:border-gray-200 hover:shadow-xs transition-all cursor-pointer"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-bold text-gray-900">{mockLot.name}</h3>
                    <p className="text-sm text-gray-500 mt-1">{mockLot.address}</p>
                  </div>
                  <div
                    className={`size-3 shrink-0 rounded-full mt-1.5 ${getDifficultyColor(mockLot.difficulty.score)}`}
                  />
                </div>

                <p className="text-sm font-medium text-blue-600 bg-blue-50/50 self-start px-3 py-1.5 rounded-lg">
                  {mockLot.curationReason}
                </p>

                <div className="flex items-center justify-between pt-2">
                  <div className="flex gap-4">
                    <span className="flex items-center gap-1 text-sm font-bold text-gray-900">
                      <Star className="size-4 fill-yellow-400 text-yellow-400" />
                      {mockLot.difficulty.score.toFixed(1)}
                    </span>
                    <span className="flex items-center gap-1 text-sm font-medium text-gray-500">
                      <MapPinPen className="size-4" />
                      {mockLot.totalSources}
                    </span>
                  </div>
                  <div className="flex gap-1.5 text-xs font-semibold text-gray-600">
                    <span className="bg-gray-100 px-3 py-1 rounded-full">
                      {mockLot.totalSpaces}면
                    </span>
                    <span className="bg-gray-100 px-3 py-1 rounded-full">무료</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* 2-B. Soft Tile (Light Gray / Elevated Content) */}
        <section>
          <h2 className="text-xl font-bold mb-4">
            2-B. 소프트 타일 (라이트 그레이 + 화이트 엘리먼트)
          </h2>
          <p className="text-sm text-muted-foreground mb-4">
            전체 카드는 극도로 연한 회색(gray-50/80)으로 깔고, 태그나 배지 같은 내부 요소를
            하얀색으로 띄워서 대비를 줍니다. 칙칙하지 않으면서 부드럽습니다.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {[1, 2].map((i) => (
              <div
                key={i}
                className="flex flex-col gap-3 rounded-[20px] bg-gray-50/80 p-5 hover:bg-gray-100/80 transition-colors cursor-pointer"
              >
                <div className="flex items-start justify-between">
                  <div className="space-y-0.5">
                    <h3 className="text-[17px] font-bold text-zinc-900">{mockLot.name}</h3>
                    <p className="text-sm text-zinc-500">{mockLot.address}</p>
                  </div>
                  <div className="flex bg-white px-2 py-1 rounded-full items-center gap-1.5 shadow-sm border border-gray-100/50">
                    <div
                      className={`size-2 shrink-0 rounded-full ${getDifficultyColor(mockLot.difficulty.score)}`}
                    />
                    <span className="text-xs font-bold">{mockLot.difficulty.score.toFixed(1)}</span>
                  </div>
                </div>

                <p className="text-sm text-zinc-700 leading-snug mt-1">{mockLot.curationReason}</p>

                <div className="mt-2 flex items-center justify-between">
                  <div className="flex gap-3">
                    <span className="flex items-center gap-1 text-sm font-medium text-zinc-600 bg-white px-2.5 py-1 rounded-full shadow-sm border border-gray-100/50">
                      <MapPinPen className="size-3.5" />
                      {mockLot.totalSources}
                    </span>
                  </div>
                  <div className="flex gap-1.5 text-xs">
                    <span className="bg-white px-2.5 py-1 rounded-md text-zinc-700 font-medium shadow-sm border border-gray-100/50">
                      {mockLot.totalSpaces}면
                    </span>
                    <span className="bg-white px-2.5 py-1 rounded-md text-zinc-700 font-medium shadow-sm border border-gray-100/50">
                      무료
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}
