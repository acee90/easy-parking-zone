import { Link } from '@tanstack/react-router'
import type { JSX } from 'react'
import { makeParkingSlug } from '@/lib/slug'

export interface AlternativeLot {
  /** 후기 본문에 등장한 이름 (우리 DB 표기와 다를 수 있다) */
  name: string
  /** 이 이름이 언급된 후기 건수 — 신뢰의 근거라 눈에 띄게 표시한다 */
  mentionCount: number
  /** 우리 DB 매칭 결과 (없으면 null) */
  matchedLotId: string | null
  matchedLotName: string | null
  /** 매칭된 주차장의 무료 여부 */
  isFree: boolean | null
  /** '만차 시 대안으로 자주 언급' 등 한 줄 설명 */
  reason: string
}

/**
 * 후기에서 함께 언급된 주차장.
 *
 * 여기가 만차일 때 사람들이 실제로 간 곳을 후기에서 뽑아 보여준다.
 * 매칭이 안 된 이름은 텍스트로만 둔다 — 검색·외부 링크로 흘려보내면 이름만 비슷한
 * 엉뚱한 주차장으로 보낼 수 있고, 그건 링크가 없는 것보다 나쁘다.
 */
export function AlternativeLotsSection({
  items,
  tip,
}: {
  items: AlternativeLot[]
  /** 후기 종합에서 뽑은 대안 팁 — 같은 「주변 주차장 대안」 주제라 이 섹션에 함께 둔다 */
  tip?: string | null
}): JSX.Element | null {
  // 언급 건수가 근거인 섹션이라 0건짜리는 실을 이유가 없다.
  // 같은 주차장이 여러 이름으로 들어올 수 있어 매칭 ID(없으면 이름) 기준으로 한 줄만 남긴다.
  const visible = new Map<string, AlternativeLot>()
  for (const item of items) {
    const name = item.name.trim()
    if (name === '' || item.mentionCount <= 0) continue
    const key = item.matchedLotId ?? name
    if (!visible.has(key)) visible.set(key, item)
  }
  if (visible.size === 0 && !tip) return null

  return (
    <section className="flex flex-col">
      <div className="mb-[11px] flex flex-wrap items-center justify-between gap-2.5">
        <h2 className="m-0 text-[17px] font-extrabold tracking-[-0.015em] text-ink">
          후기에서 함께 언급된 주차장
        </h2>
        {visible.size > 0 && (
          <span className="text-[11.5px] tabular-nums text-muted-foreground">
            여기가 만차일 때 사람들이 간 곳
          </span>
        )}
      </div>

      {tip && (
        <p className={`text-[14px] leading-relaxed text-ink-2 ${visible.size > 0 ? 'mb-3' : ''}`}>
          {tip}
        </p>
      )}

      {visible.size > 0 && (
        <ul className="mt-4 divide-y divide-zinc-100">
          {[...visible].map(([key, item]) => {
            const displayName = item.matchedLotName ?? item.name
            const reason = item.reason.trim()
            return (
              <li
                key={key}
                className="flex items-start justify-between gap-3 py-3 first:pt-0 last:pb-0"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {item.matchedLotId ? (
                      <Link
                        to="/wiki/$slug"
                        params={{ slug: makeParkingSlug(displayName, item.matchedLotId) }}
                        className="font-bold transition-colors hover:text-primary hover:underline"
                      >
                        {displayName}
                      </Link>
                    ) : (
                      <span className="font-bold">{displayName}</span>
                    )}
                    {item.isFree === true && (
                      <span className="rounded bg-green-50 px-1.5 py-0.5 text-[10px] font-bold text-green-700">
                        무료
                      </span>
                    )}
                  </div>
                  {reason !== '' && (
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{reason}</p>
                  )}
                </div>

                <span className="shrink-0 text-sm font-bold tabular-nums">
                  후기 {item.mentionCount.toLocaleString()}건
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
