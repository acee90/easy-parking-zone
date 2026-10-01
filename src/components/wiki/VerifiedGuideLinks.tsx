import { VERIFIED_PARKING_GUIDES, verifiedGuidePath } from '@/lib/verified-parking-guides'

export function VerifiedGuideLinks({ compact = false }: { compact?: boolean }) {
  if (compact)
    return (
      <nav
        aria-label="공식 정보로 확인한 주차 안내"
        className="shrink-0 overflow-x-auto bg-white px-3 py-2 text-xs"
      >
        <div className="flex min-w-max items-center gap-4">
          <span className="font-semibold">방문 전 주차 안내</span>
          {VERIFIED_PARKING_GUIDES.map((guide) => (
            <a
              key={guide.id}
              href={verifiedGuidePath(guide)}
              className="text-primary hover:underline"
            >
              {guide.name}
            </a>
          ))}
        </div>
      </nav>
    )
  return (
    <section aria-labelledby="verified-guides-title" className="rounded-[10px] bg-white px-5 py-5">
      <h2 id="verified-guides-title" className="text-xl font-bold">
        방문 전 확인한 주차 안내
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        무료 회차와 무료 주차는 다릅니다. 공식 요금·할인 조건과 진입 동선을 확인하고 출발하세요.
      </p>
      <ul className="mt-3 divide-y divide-zinc-100">
        {VERIFIED_PARKING_GUIDES.map((guide) => (
          <li key={guide.id} className="py-3">
            <a
              href={verifiedGuidePath(guide)}
              className="font-semibold text-primary hover:underline"
            >
              {guide.name} →
            </a>
            <p className="mt-1 text-sm leading-relaxed text-ink-2">{guide.summary}</p>
          </li>
        ))}
      </ul>
    </section>
  )
}
