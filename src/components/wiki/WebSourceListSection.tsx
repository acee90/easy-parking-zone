import { ChevronDown } from 'lucide-react'
import { type JSX, useState } from 'react'

export interface WebSourceRef {
  id: number
  title: string
  sourceUrl: string
  host: string
  publishedAt?: string
  author?: string
}

/**
 * 요약의 출처가 된 웹 글 목록.
 *
 * 본문·요약·원문 일부를 한 조각도 싣지 않는다. 두 가지 이유 때문이다.
 * 1) 저작권 — 남의 글 본문을 우리 페이지에 옮겨 담을 권리가 없다.
 * 2) 색인 — 원문과 같은 문장을 우리가 다시 발행하면 중복 문서로 취급돼
 *    우리 페이지와 원문 양쪽 모두 검색에서 손해를 본다.
 *
 * 그래서 남기는 건 제목·도메인·날짜·링크뿐이고, 그마저 기본은 접어 둔다.
 * 이 목록은 읽을거리가 아니라 "요약이 어디서 왔는지" 확인하는 자리다.
 */
export function WebSourceListSection({
  sources,
  excludedCount,
}: {
  sources: WebSourceRef[]
  excludedCount: number
}): JSX.Element | null {
  const [open, setOpen] = useState(false)

  if (sources.length === 0) return null

  return (
    <section className="flex flex-col">
      <div className="mb-[11px] flex flex-wrap items-center justify-between gap-2.5">
        {/* 제외 안내는 건수와 같은 줄에 둔다 — "N건"만 보면 이게 전부인 줄 안다 */}
        <div className="flex flex-wrap items-baseline gap-x-2">
          <h2 className="m-0 text-[17px] font-extrabold tracking-[-0.015em] text-ink">
            참고한 웹 글 <span className="tabular-nums">{sources.length}</span>건
          </h2>
          {excludedCount > 0 && (
            <span className="text-[11.5px] tabular-nums text-muted-foreground">
              주차장 정보 모음 사이트 <span className="tabular-nums">{excludedCount}</span>건은
              뺐습니다
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex shrink-0 cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-muted-foreground transition-colors hover:bg-zinc-100"
        >
          {open ? '접기' : '펼치기'}
          <ChevronDown className={`size-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      </div>
      <p className="text-[11.5px] tabular-nums text-muted-foreground">
        위 요약이 어디서 나왔는지 확인하고 싶을 때만 펼쳐 보세요
      </p>

      {open && (
        <ul className="mt-4 space-y-3">
          {sources.map((source) => (
            <li key={source.id}>
              <a
                href={source.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm font-semibold leading-snug transition-colors hover:text-primary hover:underline"
              >
                {source.title}
              </a>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {[source.host, source.publishedAt, source.author].filter(Boolean).join(' · ')}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
