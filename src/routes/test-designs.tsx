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

const mockFaq = [
  {
    q: '스타필드시티 명지주차장 주차요금이 얼마인가요?',
    a: '무료 주차장입니다.',
  },
  {
    q: '초보운전자도 이용할 수 있나요?',
    a: '쉬움 점수 3.3점으로 비교적 여유로운 주차장입니다.',
  },
]

const mockNearby = [
  { name: '뉴국제호텔앞 공영주차장', distance: '82m', spaces: '19면' },
  { name: '코오롱빌딩옆 노상공영주차장', distance: '89m', spaces: null },
  { name: '서울파이낸스센터 주차장', distance: '137m', spaces: null },
]

/* ---------- 공용 부품 ---------- */

function LotMeta() {
  return (
    <div className="mt-auto flex items-end justify-between pt-2">
      <div className="flex flex-wrap gap-1.5 text-xs font-medium text-zinc-600">
        <span className="rounded-md bg-zinc-100 px-2 py-1">{mockLot.totalSpaces}면</span>
        <span className="rounded-md bg-zinc-100 px-2 py-1">무료</span>
      </div>
      <div className="flex shrink-0 items-center gap-3 text-base font-bold text-zinc-900">
        <span className="flex items-center gap-1.5">
          <Star className="size-4 shrink-0 fill-yellow-400 text-yellow-400" />
          <span className="tabular-nums">{mockLot.difficulty.score.toFixed(1)}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <MapPinPen className="size-4 shrink-0 text-muted-foreground" />
          <span className="tabular-nums text-muted-foreground">{mockLot.totalSources}</span>
        </span>
      </div>
    </div>
  )
}

function LotCardBody() {
  return (
    <>
      <div className="flex items-center gap-2">
        <div
          className={`size-2.5 shrink-0 rounded-full ${getDifficultyColor(mockLot.difficulty.score)}`}
        />
        <h3 className="line-clamp-1 text-[17px] font-bold tracking-tight">{mockLot.name}</h3>
      </div>
      <p className="line-clamp-1 text-sm text-muted-foreground">{mockLot.address}</p>
      <p className="line-clamp-2 text-sm font-medium text-primary">{mockLot.curationReason}</p>
    </>
  )
}

function RankRows({ rowClass }: { rowClass: string }) {
  return (
    <>
      {[1, 2, 3].map((i) => (
        <div key={i} className={rowClass}>
          <span className="w-5 shrink-0 text-center text-sm font-bold tabular-nums text-zinc-400">
            {i}
          </span>
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
    </>
  )
}

function NearbyRows() {
  return (
    <>
      {mockNearby.map((p) => (
        <div key={p.name} className="flex items-center gap-2 py-2.5 text-sm">
          <span className="min-w-0 flex-1 truncate font-medium">{p.name}</span>
          <span className="shrink-0 text-sm font-semibold tabular-nums text-primary">
            {p.distance}
          </span>
          {p.spaces && (
            <span className="shrink-0 rounded-md bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-600 tabular-nums">
              {p.spaces}
            </span>
          )}
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        </div>
      ))}
    </>
  )
}

function VariantHeader({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="mb-6">
      <h2 className="text-2xl font-bold tracking-tight">{title}</h2>
      <p className="mt-1 max-w-xl text-sm leading-relaxed text-muted-foreground">{desc}</p>
    </div>
  )
}

function SampleLabel({ children }: { children: string }) {
  return <p className="mt-8 mb-2 text-xs font-medium text-zinc-400 first:mt-0">{children}</p>
}

/* ---------- 시안 A: 톤 대비형 ---------- */

function VariantA() {
  return (
    <section className="rounded-2xl bg-zinc-50 p-5 md:p-8">
      <VariantHeader
        title="시안 A. 톤 대비형"
        desc="페이지 배경을 아주 연한 회색으로 깔고, 카드는 순수 흰색. 테두리와 그림자 없이 배경 대비만으로 표면을 분리합니다. 카카오맵·토스 계열의 안정적인 방식입니다."
      />

      <SampleLabel>둘러보기 · 추천 카드</SampleLabel>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {[1, 2].map((i) => (
          <div
            key={i}
            className="flex h-full cursor-pointer flex-col gap-2 rounded-2xl bg-white p-5 transition-transform active:scale-[0.99]"
          >
            <LotCardBody />
            <LotMeta />
          </div>
        ))}
      </div>

      <SampleLabel>둘러보기 · 랭킹 리스트</SampleLabel>
      <div className="divide-y divide-zinc-100 overflow-hidden rounded-2xl bg-white">
        <RankRows rowClass="flex cursor-pointer items-center gap-2.5 px-4 py-3.5 text-base transition-colors active:bg-zinc-50" />
      </div>

      <SampleLabel>상세 페이지 · FAQ + 주변 주차장</SampleLabel>
      <div className="space-y-3">
        <div className="rounded-2xl bg-white p-5">
          <h3 className="mb-3 text-base font-bold tracking-tight">자주 묻는 질문</h3>
          <dl className="divide-y divide-zinc-100">
            {mockFaq.map((f) => (
              <div key={f.q} className="py-3 first:pt-0 last:pb-0">
                <dt className="text-sm font-semibold">{f.q}</dt>
                <dd className="mt-1 text-sm leading-relaxed text-muted-foreground">{f.a}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="rounded-2xl bg-white p-5">
          <h3 className="mb-1 text-base font-bold tracking-tight">주변 주차장</h3>
          <div className="divide-y divide-zinc-100">
            <NearbyRows />
          </div>
        </div>
      </div>
    </section>
  )
}

/* ---------- 시안 B: 필 타일형 ---------- */

function VariantB() {
  return (
    <section className="rounded-2xl bg-white p-5 md:p-8">
      <VariantHeader
        title="시안 B. 필 타일형"
        desc="페이지는 흰색 그대로 두고, 카드를 연한 회색 필(fill)로 채웁니다. 테두리·그림자 없음. 눌리는 느낌의 터치 피드백과 잘 어울리고, 지금 구조에서 이탈이 가장 적습니다."
      />

      <SampleLabel>둘러보기 · 추천 카드</SampleLabel>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {[1, 2].map((i) => (
          <div
            key={i}
            className="flex h-full cursor-pointer flex-col gap-2 rounded-2xl bg-zinc-50 p-5 transition-colors active:bg-zinc-100"
          >
            <div className="flex items-center gap-2">
              <div
                className={`size-2.5 shrink-0 rounded-full ${getDifficultyColor(mockLot.difficulty.score)}`}
              />
              <h3 className="line-clamp-1 text-[17px] font-bold tracking-tight">{mockLot.name}</h3>
            </div>
            <p className="line-clamp-1 text-sm text-muted-foreground">{mockLot.address}</p>
            <p className="line-clamp-2 text-sm font-medium text-primary">
              {mockLot.curationReason}
            </p>
            <div className="mt-auto flex items-end justify-between pt-2">
              <div className="flex flex-wrap gap-1.5 text-xs font-medium text-zinc-600">
                <span className="rounded-md bg-white px-2 py-1">{mockLot.totalSpaces}면</span>
                <span className="rounded-md bg-white px-2 py-1">무료</span>
              </div>
              <div className="flex shrink-0 items-center gap-3 text-base font-bold text-zinc-900">
                <span className="flex items-center gap-1.5">
                  <Star className="size-4 shrink-0 fill-yellow-400 text-yellow-400" />
                  <span className="tabular-nums">{mockLot.difficulty.score.toFixed(1)}</span>
                </span>
                <span className="flex items-center gap-1.5">
                  <MapPinPen className="size-4 shrink-0 text-muted-foreground" />
                  <span className="tabular-nums text-muted-foreground">{mockLot.totalSources}</span>
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>

      <SampleLabel>둘러보기 · 랭킹 리스트</SampleLabel>
      <div className="overflow-hidden rounded-2xl bg-zinc-50">
        <RankRows rowClass="flex cursor-pointer items-center gap-2.5 px-4 py-3.5 text-base transition-colors active:bg-zinc-100" />
      </div>

      <SampleLabel>상세 페이지 · FAQ + 주변 주차장</SampleLabel>
      <div className="space-y-3">
        <div className="rounded-2xl bg-zinc-50 p-5">
          <h3 className="mb-3 text-base font-bold tracking-tight">자주 묻는 질문</h3>
          <dl className="space-y-2">
            {mockFaq.map((f) => (
              <div key={f.q} className="rounded-xl bg-white p-4">
                <dt className="text-sm font-semibold">{f.q}</dt>
                <dd className="mt-1 text-sm leading-relaxed text-muted-foreground">{f.a}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="rounded-2xl bg-zinc-50 p-5">
          <h3 className="mb-1 text-base font-bold tracking-tight">주변 주차장</h3>
          <div className="divide-y divide-zinc-200/70">
            <NearbyRows />
          </div>
        </div>
      </div>
    </section>
  )
}

/* ---------- 시안 C: 디바이더형 ---------- */

function VariantC() {
  return (
    <section className="rounded-2xl bg-white p-5 md:p-8">
      <VariantHeader
        title="시안 C. 디바이더형"
        desc="카드 표면 자체를 없애고 여백과 얇은 구분선만으로 정리합니다. 가장 에디토리얼하고 콘텐츠 중심이지만, 터치 영역 구분이 약해져 모바일에서는 호불호가 갈릴 수 있습니다."
      />

      <SampleLabel>둘러보기 · 추천 카드</SampleLabel>
      <div className="grid grid-cols-1 md:grid-cols-2 md:gap-x-10">
        {[1, 2].map((i) => (
          <div
            key={i}
            className="flex h-full cursor-pointer flex-col gap-2 border-b border-zinc-100 py-5 transition-colors active:bg-zinc-50 md:border-b-0"
          >
            <LotCardBody />
            <LotMeta />
          </div>
        ))}
      </div>

      <SampleLabel>둘러보기 · 랭킹 리스트</SampleLabel>
      <div className="divide-y divide-zinc-100">
        <RankRows rowClass="flex cursor-pointer items-center gap-2.5 py-3.5 text-base transition-colors active:bg-zinc-50" />
      </div>

      <SampleLabel>상세 페이지 · FAQ + 주변 주차장</SampleLabel>
      <div className="space-y-8">
        <div>
          <h3 className="mb-2 text-base font-bold tracking-tight">자주 묻는 질문</h3>
          <dl className="divide-y divide-zinc-100">
            {mockFaq.map((f) => (
              <div key={f.q} className="py-3">
                <dt className="text-sm font-semibold">{f.q}</dt>
                <dd className="mt-1 text-sm leading-relaxed text-muted-foreground">{f.a}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div>
          <h3 className="mb-1 text-base font-bold tracking-tight">주변 주차장</h3>
          <div className="divide-y divide-zinc-100">
            <NearbyRows />
          </div>
        </div>
      </div>
    </section>
  )
}

/* ---------- 시안 D: A+C 하이브리드 ---------- */

function VariantD() {
  return (
    <section className="rounded-2xl bg-zinc-50 p-5 md:p-8" id="variant-d">
      <VariantHeader
        title="시안 D. A+C 하이브리드"
        desc="탐색 화면(둘러보기)은 A 그대로: 회색 페이지 + 흰 카드. 상세 페이지는 하나의 큰 흰 시트를 깔고, 그 안에서 C의 디바이더로만 섹션을 나눕니다. 카드 안의 카드가 사라지고 문서처럼 읽힙니다."
      />

      <SampleLabel>둘러보기 · 추천 카드 (A 방식)</SampleLabel>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {[1, 2].map((i) => (
          <div
            key={i}
            className="flex h-full cursor-pointer flex-col gap-2 rounded-2xl bg-white p-5 transition-transform active:scale-[0.99]"
          >
            <LotCardBody />
            <LotMeta />
          </div>
        ))}
      </div>

      <SampleLabel>둘러보기 · 랭킹 리스트 (A 방식)</SampleLabel>
      <div className="divide-y divide-zinc-100 overflow-hidden rounded-2xl bg-white">
        <RankRows rowClass="flex cursor-pointer items-center gap-2.5 px-4 py-3.5 text-base transition-colors active:bg-zinc-50" />
      </div>

      <SampleLabel>상세 페이지 · 흰 시트 1장 + 내부 디바이더 (C 방식)</SampleLabel>
      <div className="rounded-2xl bg-white p-5 md:p-6">
        <div className="divide-y divide-zinc-100">
          <div className="pb-5">
            <h3 className="mb-2 text-base font-bold tracking-tight">자주 묻는 질문</h3>
            <dl className="space-y-3">
              {mockFaq.map((f) => (
                <div key={f.q}>
                  <dt className="text-sm font-semibold">{f.q}</dt>
                  <dd className="mt-1 text-sm leading-relaxed text-muted-foreground">{f.a}</dd>
                </div>
              ))}
            </dl>
          </div>
          <div className="py-5">
            <h3 className="mb-2 text-base font-bold tracking-tight">리뷰</h3>
            <p className="text-sm leading-relaxed text-muted-foreground">
              아직 리뷰가 없습니다. 첫 리뷰를 남겨보세요.
            </p>
          </div>
          <div className="pt-5">
            <h3 className="mb-1 text-base font-bold tracking-tight">주변 주차장</h3>
            <div className="divide-y divide-zinc-100">
              <NearbyRows />
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

export function TestDesignsPage() {
  return (
    <div className="min-h-dvh bg-zinc-100 p-4 md:p-8">
      <div className="mx-auto max-w-4xl space-y-8">
        <div>
          <h1 className="mb-2 text-3xl font-bold tracking-tight">카드 시안: borderless 3종</h1>
          <p className="text-muted-foreground">
            같은 콘텐츠(추천 카드 / 랭킹 리스트 / 상세 FAQ·주변 주차장)를 세 가지 borderless
            방식으로 렌더한 비교 시안입니다.
          </p>
        </div>
        <VariantD />
        <VariantA />
        <VariantB />
        <VariantC />
      </div>
    </div>
  )
}
